// packages/sandbox/src/opencode/fetch.ts
import type { Sandbox } from '../sandbox';

/**
 * Creates a fetch function that routes requests through the Sandbox container.
 *
 * This adapter allows the OpenCode SDK to communicate with an OpenCode server
 * running inside a Sandbox container. The SDK creates Request objects with
 * URLs like http://localhost:4096/session, and this fetch function routes
 * them through containerFetch to reach the container port.
 *
 * @param sandbox - The Sandbox instance to route requests through
 * @param port - The container port where OpenCode server is running (default: 4096)
 * @returns A fetch function compatible with the OpenCode SDK's fetch option
 *
 * @example
 * ```typescript
 * import { createOpencodeClient } from '@opencode-ai/sdk'
 * import { createSandboxFetch } from '@cloudflare/sandbox/opencode'
 *
 * const client = createOpencodeClient({
 *   baseUrl: 'http://localhost:4096',
 *   fetch: createSandboxFetch(sandbox, 4096)
 * })
 * ```
 */
export function createSandboxFetch(
  sandbox: Sandbox<any>,
  port = 4096
): (request: Request) => Promise<Response> {
  return (request: Request): Promise<Response> => {
    return sandbox.containerFetch(request, port);
  };
}
