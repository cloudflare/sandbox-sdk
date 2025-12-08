import { BridgeSandboxClient } from './sandbox-client';
import type { ClientOptions } from './types';

/**
 * Get a sandbox client that communicates with a bridge Worker via HTTP
 *
 * This allows accessing Sandbox from any platform (Python, Go, browsers, etc.)
 * by connecting to a bridge Worker that proxies requests to the actual Sandbox.
 *
 * @param id - The sandbox ID to connect to
 * @param options - Client configuration options
 * @returns A SandboxClient instance
 *
 * @example
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox/client';
 *
 * const sandbox = getSandbox('my-project', {
 *   baseUrl: 'https://my-bridge.workers.dev',
 *   apiKey: process.env.SANDBOX_API_KEY
 * });
 *
 * const result = await sandbox.exec('ls -la');
 * console.log(result.stdout);
 * ```
 */
export function getSandbox(
  id: string,
  options?: ClientOptions
): BridgeSandboxClient {
  const apiKey = options?.apiKey || getEnvVar('SANDBOX_API_KEY');
  const baseUrl = options?.baseUrl || getEnvVar('SANDBOX_BRIDGE_URL');

  if (!apiKey) {
    throw new Error(
      'API key required. Set SANDBOX_API_KEY environment variable or pass apiKey option.'
    );
  }
  if (!baseUrl) {
    throw new Error(
      'Base URL required. Set SANDBOX_BRIDGE_URL environment variable or pass baseUrl option.'
    );
  }

  return new BridgeSandboxClient(id, {
    apiKey,
    baseUrl,
    timeout: options?.timeout
  });
}

/**
 * Helper to get environment variable in both Node.js and browser environments
 */
function getEnvVar(name: string): string | undefined {
  // Node.js / Bun
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }
  // Browser or other environments
  return undefined;
}
