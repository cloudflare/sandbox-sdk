/**
 * OpenCode integration for Cloudflare Sandbox.
 *
 * Attach a durable lifecycle handle to a Sandbox subclass and build a typed
 * SDK client from either the Worker stub or inside the DO.
 *
 * @example Worker
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpenCodeProxy, createOpenCodeClient } from '@cloudflare/sandbox/opencode'
 *
 * export default createOpenCodeProxy(
 *   (env) => getSandbox(env.Sandbox, 'my-sandbox')
 * )({
 *   async fetch(request, env) {
 *     const sandbox = getSandbox(env.Sandbox, 'my-sandbox')
 *     const client = await createOpenCodeClient(sandbox.opencode)
 *     await client.session.create()
 *     return Response.json({ ok: true })
 *   }
 * })
 * ```
 *
 * @example Durable Object
 * ```typescript
 * import { Sandbox, withOpenCode } from '@cloudflare/sandbox/opencode'
 *
 * class MySandbox extends Sandbox {
 *   opencode = withOpenCode(this)
 * }
 * ```
 *
 * @packageDocumentation
 */

export { createOpenCodeClient } from './client';
export {
  type OpenCodeConfig,
  OpenCodeHandle,
  type OpenCodeServerInfo,
  type OpenCodeStatus,
  reEnsureOpenCodeHandles,
  withOpenCode
} from './lifecycle';
// Lower-level helpers retained for direct use and back-compat.
export {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
  proxyToOpencodeServer
} from './opencode';
export {
  createOpenCodeProxy,
  type OpenCodeProxyOptions,
  tryProxyOpenCode
} from './proxy';
export { Sandbox } from './sandbox';
export type { OpencodeOptions, OpencodeResult, OpencodeServer } from './types';
export { OpencodeStartupError } from './types';
