import { execSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WranglerDevOptions {
  cwd?: string;
  timeout?: number;
  env?: typeof process.env;
}

/**
 * Get the test worker URL and runner for E2E tests
 *
 * Priority order:
 * 1. TEST_WORKER_URL - Deployed worker (CI mode)
 * 2. TEST_WORKER_URL_GLOBAL_SETUP - Shared wrangler dev from global setup (parallel local mode)
 * 3. Spawn new wrangler dev - Fallback for serial local mode (deprecated)
 *
 * NOTE: wrangler.jsonc is generated from wrangler.template.jsonc automatically
 * on first run. You don't need to run any setup commands manually.
 */
export async function getTestWorkerUrl(): Promise<{ url: string; runner: WranglerDevRunner | null }> {
  // CI mode: use deployed worker URL
  if (process.env.TEST_WORKER_URL) {
    console.log('Using deployed test worker:', process.env.TEST_WORKER_URL);
    return { url: process.env.TEST_WORKER_URL, runner: null };
  }

  // Parallel local mode: use shared wrangler dev from global setup
  if (process.env.TEST_WORKER_URL_GLOBAL_SETUP) {
    console.log('Using shared wrangler dev from global setup:', process.env.TEST_WORKER_URL_GLOBAL_SETUP);
    return { url: process.env.TEST_WORKER_URL_GLOBAL_SETUP, runner: null };
  }

  // Local mode: ensure config exists before spawning wrangler dev
  const testWorkerDir = 'tests/e2e/test-worker';
  const configPath = join(testWorkerDir, 'wrangler.jsonc');

  if (!existsSync(configPath)) {
    console.log('wrangler.jsonc not found, generating from template...');
    try {
      execSync('./generate-config.sh', {
        cwd: testWorkerDir,
        stdio: 'inherit'
      });
      console.log('✅ Generated wrangler.jsonc');
    } catch (error) {
      throw new Error(`Failed to generate wrangler.jsonc: ${error}`);
    }
  }

  // Spawn wrangler dev
  console.log('Spawning local wrangler dev...');
  const runner = new WranglerDevRunner({ cwd: testWorkerDir });
  const url = await runner.getUrl();
  return { url, runner };
}

/**
 * WranglerDevRunner - Manages wrangler dev lifecycle for integration tests
 *
 * Based on patterns from @cloudflare/containers test suite.
 *
 * Usage:
 * ```typescript
 * const runner = new WranglerDevRunner({ cwd: 'packages/sandbox' });
 * const url = await runner.getUrl();
 *
 * // Run tests against url...
 *
 * await runner.stop([sandboxId1, sandboxId2]);
 * ```
 */
export class WranglerDevRunner {
  private process: ChildProcessWithoutNullStreams;
  private stdout: string = '';
  private stderr: string = '';
  private url: string | null = null;
  private readonly timeout: number;
  private urlPromise: Promise<string>;

  constructor(private options: WranglerDevOptions = {}) {
    // Default to 5 minutes timeout to allow for Docker startup and initialization
    // After first run with pre-built image, startup is typically < 30s
    this.timeout = options.timeout || 300000;

    // Spawn wrangler dev
    this.process = spawn('npx', ['wrangler', 'dev'], {
      cwd: this.options.cwd,
      env: this.options.env || process.env,
      stdio: 'pipe',
    });

    // Capture stdout/stderr and extract URL
    this.urlPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout after ${this.timeout}ms waiting for wrangler dev to be ready`));
      }, this.timeout);

      this.process.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        this.stdout += output;
        console.log(output);

        // Check for ready pattern: "Ready on http://..."
        const match = output.match(/Ready on (?<url>https?:\/\/[^\s]+)/);
        if (match && match.groups?.url && !this.url) {
          this.url = match.groups.url;
          clearTimeout(timeoutId);
          resolve(this.url);
        }
      });

      this.process.stderr.on('data', (data: Buffer) => {
        this.stderr += data.toString();
        console.log(data.toString());
      });

      this.process.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      this.process.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeoutId);
          reject(new Error(`Wrangler dev exited with code ${code} before becoming ready`));
        }
        if (signal) {
          clearTimeout(timeoutId);
          reject(new Error(`Wrangler dev killed by signal ${signal} before becoming ready`));
        }
      });
    });
  }

  /**
   * Get captured stdout (useful for verifying lifecycle hooks)
   */
  getStdout(): string {
    return this.stdout;
  }

  /**
   * Get captured stderr
   */
  getStderr(): string {
    return this.stderr;
  }

  /**
   * Wait for wrangler dev to be ready and return the URL
   */
  async getUrl(): Promise<string> {
    return this.urlPromise;
  }

  /**
   * Stop wrangler dev process
   *
   * Note: Container cleanup is now handled by afterEach hooks calling cleanupSandbox()
   * directly, so this method only needs to stop the wrangler process.
   *
   * Cleanup sequence:
   * 1. Send SIGTERM to wrangler process
   * 2. Wait up to 5 seconds for graceful shutdown
   * 3. Send SIGKILL if still running
   */
  async stop(): Promise<void> {
    if (!this.process || this.process.killed) {
      console.log('Wrangler process already stopped');
      return;
    }

    console.log('Stopping wrangler dev process...');

    // Send SIGTERM for graceful shutdown
    this.process.kill('SIGTERM');

    // Wait for process to exit (with timeout)
    const exitPromise = new Promise<void>(resolve => {
      this.process.on('close', () => {
        console.log('Wrangler process stopped gracefully');
        resolve();
      });
    });

    const timeoutPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        if (!this.process.killed) {
          console.warn('Wrangler process did not stop gracefully, sending SIGKILL');
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);
    });

    await Promise.race([exitPromise, timeoutPromise]);
  }
}
