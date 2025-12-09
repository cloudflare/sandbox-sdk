/**
 * OpenCode integration for Cloudflare Sandbox
 *
 * Use `createOpencode()` to start an OpenCode server in a Sandbox container
 * and get an SDK client for programmatic access or web UI proxying.
 *
 * @example Programmatic SDK
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencode } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const { client, server } = await createOpencode(sandbox, {
 *   directory: '/home/user/my-project',
 *   config: { provider: { anthropic: { options: { apiKey: env.ANTHROPIC_KEY } } } }
 * })
 *
 * // Use SDK client
 * const session = await client.session.create()
 *
 * // Or proxy to web UI
 * return sandbox.containerFetch(request, server.port)
 * ```
 *
 * @packageDocumentation
 */

export {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode
} from './opencode';
export type { OpencodeOptions, OpencodeResult, OpencodeServer } from './types';
export { OpencodeStartupError } from './types';
