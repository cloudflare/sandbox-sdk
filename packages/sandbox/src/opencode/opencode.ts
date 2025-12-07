import type { Process } from '@repo/shared';
import type { Sandbox } from '../sandbox';
import { createSandboxFetch } from './fetch';
import type {
  OpencodeOptions,
  OpencodeResult,
  OpencodeServer,
  ProxyToOpencodeOptions
} from './types';
import { OpencodeStartupError } from './types';

const DEFAULT_PORT = 4096;

// Dynamic import to handle peer dependency
let createOpencodeClient: any;

async function ensureSdkLoaded(): Promise<void> {
  if (createOpencodeClient) return;

  try {
    const sdk = await import('@opencode-ai/sdk');
    createOpencodeClient = sdk.createOpencodeClient;
  } catch {
    throw new Error(
      '@opencode-ai/sdk is required for OpenCode integration. ' +
        'Install it with: npm install @opencode-ai/sdk'
    );
  }
}

/**
 * Find an existing OpenCode server process running on the specified port.
 * Returns the process if found and still active, null otherwise.
 */
async function findExistingOpencodeProcess(
  sandbox: Sandbox<any>,
  port: number
): Promise<Process | null> {
  const processes = await sandbox.listProcesses();
  const command = `opencode serve --port ${port}`;

  for (const proc of processes) {
    if (proc.command.includes(command)) {
      if (proc.status === 'starting' || proc.status === 'running') {
        return proc;
      }
    }
  }

  return null;
}

/**
 * Ensures OpenCode server is running in the container.
 * Reuses existing process if one is already running on the specified port.
 * Returns the process handle.
 */
async function ensureOpencodeServer(
  sandbox: Sandbox<any>,
  port: number,
  config?: Record<string, unknown>
): Promise<Process> {
  // Check if OpenCode is already running on this port
  let process = await findExistingOpencodeProcess(sandbox, port);

  if (process) {
    // Reuse existing process - wait for it to be ready if still starting
    if (process.status === 'starting') {
      try {
        await process.waitForPort(port, {
          mode: 'http',
          path: '/',
          timeout: 60_000
        });
      } catch (e) {
        const logs = await process.getLogs();
        throw new OpencodeStartupError(
          `OpenCode server failed to start. Stderr: ${logs.stderr || '(empty)'}`,
          { cause: e }
        );
      }
    }
    return process;
  }

  // Start new OpenCode server
  // Pass config via OPENCODE_CONFIG_CONTENT and also extract API keys to env vars
  // because OpenCode's provider auth looks for env vars like ANTHROPIC_API_KEY
  const env: Record<string, string> = {};

  if (config) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

    // Extract API keys from config and set as env vars
    const providers = (
      config as { provider?: Record<string, { apiKey?: string }> }
    ).provider;
    if (providers) {
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        if (providerConfig?.apiKey) {
          // Convert provider ID to env var name (e.g., anthropic -> ANTHROPIC_API_KEY)
          const envVar = `${providerId.toUpperCase()}_API_KEY`;
          env[envVar] = providerConfig.apiKey;
        }
      }
    }
  }

  process = await sandbox.startProcess(
    `opencode serve --port ${port} --hostname 0.0.0.0`,
    { env: Object.keys(env).length > 0 ? env : undefined }
  );

  // Wait for server to be ready
  try {
    await process.waitForPort(port, {
      mode: 'http',
      path: '/',
      timeout: 60_000
    });
  } catch (e) {
    const logs = await process.getLogs();
    throw new OpencodeStartupError(
      `OpenCode server failed to start. Stderr: ${logs.stderr || '(empty)'}`,
      { cause: e }
    );
  }

  return process;
}

/**
 * Creates an OpenCode server inside a Sandbox container and returns a typed SDK client.
 *
 * This function is API-compatible with OpenCode's own createOpencode(), but uses
 * Sandbox process management instead of Node.js spawn. The returned client uses
 * a custom fetch adapter to route requests through the Sandbox container.
 *
 * If an OpenCode server is already running on the specified port, this function
 * will reuse it instead of starting a new one.
 *
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to { client, server }
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencode } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const { client, server } = await createOpencode(sandbox, {
 *   config: { provider: { anthropic: { apiKey: env.ANTHROPIC_KEY } } }
 * })
 *
 * const session = await client.session.create({ body: { title: 'Task' } })
 * ```
 */
export async function createOpencode<TClient = unknown>(
  sandbox: Sandbox<any>,
  options?: OpencodeOptions
): Promise<OpencodeResult<TClient>> {
  await ensureSdkLoaded();

  const port = options?.port ?? DEFAULT_PORT;
  const process = await ensureOpencodeServer(sandbox, port, options?.config);

  // Create SDK client with Sandbox transport
  const client = createOpencodeClient({
    baseUrl: `http://localhost:${port}`,
    fetch: createSandboxFetch(sandbox, port)
  }) as TClient;

  // Build server handle
  const server: OpencodeServer = {
    port,
    url: `http://localhost:${port}`,
    process,
    stop: () => process.kill('SIGTERM')
  };

  return { client, server };
}

/**
 * Proxies HTTP requests to OpenCode running in a Sandbox container.
 *
 * This is the simplest way to expose OpenCode's web UI through a Cloudflare Worker.
 * It handles:
 * - Starting the OpenCode server (with automatic process reuse)
 * - Redirecting localhost requests to use the correct API URL
 * - Proxying all requests to the container
 *
 * @param request - The incoming HTTP request
 * @param sandbox - The Sandbox instance to run OpenCode in
 * @param options - Configuration options
 * @returns Promise resolving to the proxied Response
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { proxyToOpencode } from '@cloudflare/sandbox/opencode'
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const sandbox = getSandbox(env.Sandbox, 'opencode')
 *     return proxyToOpencode(request, sandbox, {
 *       config: { provider: { anthropic: { apiKey: env.ANTHROPIC_API_KEY } } }
 *     })
 *   }
 * }
 * ```
 */
export async function proxyToOpencode(
  request: Request,
  sandbox: Sandbox<any>,
  options?: ProxyToOpencodeOptions
): Promise<Response> {
  const url = new URL(request.url);
  const port = options?.port ?? DEFAULT_PORT;

  // OpenCode's web UI connects to 127.0.0.1:4096 when hostname includes "localhost".
  // Redirect navigational requests to include ?url= param so the UI uses our proxy.
  // Only redirect browser navigations (GET with Accept: text/html), not API requests.
  const isNavigation =
    request.method === 'GET' &&
    request.headers.get('Accept')?.includes('text/html');

  if (
    url.hostname === 'localhost' &&
    !url.searchParams.has('url') &&
    isNavigation
  ) {
    url.searchParams.set('url', url.origin);
    return Response.redirect(url.toString(), 302);
  }

  // Ensure OpenCode server is running
  await ensureOpencodeServer(sandbox, port, options?.config);

  // Proxy the request to OpenCode
  return sandbox.containerFetch(request, port);
}
