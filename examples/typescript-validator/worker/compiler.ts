import { getSandbox } from '@cloudflare/sandbox';
import type { ValidateRequest, ValidateResponse, ErrorResponse } from './types';

/**
 * Compiler Durable Object
 * Orchestrates TypeScript compilation and execution
 * Caches compiled bundles in persistent storage
 */
export class CompilerDO implements DurableObject {
  private env: Env;
  private state: DurableObjectState;
  private static readonly CLEANUP_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /validate - Validate TypeScript schema with test data
    if (url.pathname === '/validate' && request.method === 'POST') {
      return this.handleValidate(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Alarm handler for automatic storage cleanup
   */
  async alarm(): Promise<void> {
    console.log('Cleaning up storage for inactive session');
    await this.state.storage.deleteAll();
  }

  /**
   * Hash schema code to detect changes
   */
  private async hashCode(code: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(code);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Validate TypeScript schema with test data
   */
  private async handleValidate(request: Request): Promise<Response> {
    try {
      // Parse request
      const body = (await request.json()) as ValidateRequest;
      if (!body.schemaCode || typeof body.schemaCode !== 'string') {
        return Response.json(
          {
            error: 'Missing or invalid "schemaCode" field'
          } satisfies ErrorResponse,
          { status: 400 }
        );
      }

      // Validate code size (10KB limit)
      if (body.schemaCode.length > 10 * 1024) {
        return Response.json(
          { error: 'Schema code too large (max 10KB)' } satisfies ErrorResponse,
          { status: 400 }
        );
      }

      // Validate test data size (100KB limit)
      const testDataStr = JSON.stringify(body.testData);
      if (testDataStr.length > 100 * 1024) {
        return Response.json(
          { error: 'Test data too large (max 100KB)' } satisfies ErrorResponse,
          { status: 400 }
        );
      }

      // Hash schema code to check cache
      const codeHash = await this.hashCode(body.schemaCode);
      const sessionId = codeHash.slice(0, 8); // Short ID

      // Check DO storage for cached bundle
      let bundledCode = await this.state.storage.get<string>(codeHash);

      let compiled = false;
      const timings: {
        install?: number;
        bundle?: number;
        load: number;
        execute: number;
      } = {
        load: 0,
        execute: 0
      };

      // Compile if not cached
      if (!bundledCode) {
        // Start timing for all Sandbox SDK operations
        const compileStart = Date.now();
        const sandbox = getSandbox(this.env.Sandbox, `compile-${sessionId}`);

        try {
          // Write TypeScript schema
          await sandbox.writeFile('/workspace/validator.ts', body.schemaCode);

          // Bundle with esbuild (using pre-installed dependencies from /base)
          const bundleResult = await sandbox.exec(
            'NODE_PATH=/base/node_modules esbuild validator.ts --bundle --format=esm --outfile=bundle.js',
            {
              timeout: 60000,
              cwd: '/workspace'
            }
          );
          timings.bundle = Date.now() - compileStart;

          if (!bundleResult.success) {
            return Response.json(
              {
                error: 'Build failed',
                details: bundleResult.stderr
              } satisfies ErrorResponse,
              { status: 400 }
            );
          }

          // Read bundled code
          const bundleFile = await sandbox.readFile('/workspace/bundle.js');
          bundledCode = bundleFile.content;

          // Store bundle in DO storage
          await this.state.storage.put(codeHash, bundledCode);
          compiled = true;

          // Set alarm to clean up after 2 hours of inactivity
          await this.state.storage.setAlarm(
            Date.now() + CompilerDO.CLEANUP_DELAY_MS
          );
        } finally {
          // Always cleanup sandbox
          await sandbox.destroy();
        }
      }

      // Load code into Dynamic Worker
      const loadStart = Date.now();

      const worker = this.env.LOADER.get(codeHash, () => {
        return {
          compatibilityDate: '2025-11-09',
          mainModule: 'index.js',
          modules: {
            'index.js': `
              import { schema } from './validator.js';

              export default {
                async fetch(request) {
                  try {
                    const data = await request.json();
                    const result = schema.safeParse(data);
                    return new Response(JSON.stringify(result), {
                      headers: { 'content-type': 'application/json' }
                    });
                  } catch (error) {
                    return new Response(JSON.stringify({
                      error: 'Execution failed',
                      details: error.message
                    }), {
                      status: 500,
                      headers: { 'content-type': 'application/json' }
                    });
                  }
                }
              }
            `,
            'validator.js': bundledCode!
          },
          globalOutbound: null // No network access
        };
      });

      timings.load = Date.now() - loadStart;

      // Execute in Dynamic Worker
      const executeStart = Date.now();

      // Create request with test data
      const testRequest = new Request('http://worker/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body.testData)
      });

      const response = await worker.getEntrypoint().fetch(testRequest);
      const result = (await response.json()) as {
        success: boolean;
        data?: unknown;
        error?: { issues: unknown[] };
      };

      timings.execute = Date.now() - executeStart;

      // Update alarm on each validation to extend cleanup time
      await this.state.storage.setAlarm(
        Date.now() + CompilerDO.CLEANUP_DELAY_MS
      );

      // Return validation response
      return Response.json({
        sessionId,
        compiled,
        timings,
        result
      } satisfies ValidateResponse);
    } catch (error) {
      console.error('Validation error:', error);
      return Response.json(
        {
          error: 'Internal server error',
          details: error instanceof Error ? error.message : String(error)
        } satisfies ErrorResponse,
        { status: 500 }
      );
    }
  }
}
