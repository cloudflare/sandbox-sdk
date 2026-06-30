/**
 * OpenCode integration for Cloudflare Sandbox.
 *
 * Attach a durable lifecycle handle to your Sandbox subclass as a field and
 * build a typed SDK client from either the Worker stub or inside the DO.
 *
 * @example Durable Object
 * ```typescript
 * import { Sandbox as BaseSandbox } from '@cloudflare/sandbox'
 * import { withOpenCode } from '@cloudflare/sandbox/opencode'
 *
 * export class Sandbox extends BaseSandbox<Env> {
 *   opencode = withOpenCode(this, { storage: this.ctx.storage })
 * }
 * ```
 *
 * @example Worker
 * ```typescript
 * import { getSandbox } from '@cloudflare/sandbox'
 * import { createOpenCodeProxy, createOpenCodeClient } from '@cloudflare/sandbox/opencode'
 *
 * export default createOpenCodeProxy(
 *   (env) => getSandbox(env.Sandbox, 'my-sandbox').opencode
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
 * @packageDocumentation
 */

export { createOpenCodeClient } from './client';
export {
  type OpenCodeConfig,
  OpenCodeHandle,
  type OpenCodeServerInfo,
  type OpenCodeStateStorage,
  type OpenCodeStatus,
  type WithOpenCodeOptions,
  withOpenCode
} from './lifecycle';
export {
  createOpenCodeProxy,
  type OpenCodeProxyOptions,
  proxyToOpenCodeUI
} from './proxy';
export type { OpenCodeOptions, OpenCodeServer } from './types';
export { OpenCodeStartupError } from './types';
