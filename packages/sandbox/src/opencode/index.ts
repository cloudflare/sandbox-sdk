/**
 * OpenCode integration for Cloudflare Sandbox
 *
 * This module provides two ways to use OpenCode inside Sandbox containers:
 *
 * 1. **Web UI** - Use `proxyToOpencode()` to expose the full OpenCode web experience
 * 2. **Programmatic** - Use `createOpencode()` to get an SDK client for automation
 *
 * @example Web UI
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
 *
 * @example Programmatic SDK
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpencode } from '@cloudflare/sandbox/opencode'
 *
 * const sandbox = getSandbox(env.Sandbox, 'my-agent')
 * const { client } = await createOpencode(sandbox, {
 *   config: { provider: { anthropic: { apiKey: env.ANTHROPIC_KEY } } }
 * })
 *
 * const session = await client.session.create({ body: { title: 'Task' } })
 * ```
 *
 * @packageDocumentation
 */

export { createOpencode, proxyToOpencode } from './opencode';
export type {
  OpencodeOptions,
  OpencodeResult,
  OpencodeServer,
  ProxyToOpencodeOptions
} from './types';
export { OpencodeStartupError } from './types';
