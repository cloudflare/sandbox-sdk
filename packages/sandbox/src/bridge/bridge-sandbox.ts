/**
 * `BridgeSandbox`: the typed wrapper around the SDK's `getSandbox()` proxy
 * used everywhere bridge routes need to talk to a sandbox. Lifted out of
 * `routes.ts` so both `routes.ts` and `rpc-api.ts` can share the type and
 * the typed factory without a circular import.
 */

import type { ExecutionSession, PtyOptions } from '@repo/shared';
import type { Sandbox } from '../sandbox';
import { getSandbox as _getSandbox } from '../sandbox';

/**
 * `getSandbox()` decorates the underlying `Sandbox` stub with two
 * proxy-only methods that don't appear on the class itself:
 *
 * - `terminal(request, options)` — PTY WebSocket entry point.
 * - `destroy()` — explicit container teardown.
 *
 * It also re-types `getSession()` so the returned `ExecutionSession`
 * carries its own `terminal()`. We bake these into the `BridgeSandbox`
 * type so call sites get type safety without per-call casts.
 */
/**
 * Pick only the public-facing keys of `T` so private/protected members on
 * the runtime `Sandbox` class don't leak into the bridge surface.
 */
type PublicInterface<T> = Pick<T, keyof T>;

export type BridgeSandbox = PublicInterface<Sandbox<any>> & {
  terminal(request: Request, options?: PtyOptions): Promise<Response>;
  destroy(): Promise<void>;
  getSession(sessionId: string): Promise<
    ExecutionSession & {
      terminal(request: Request, options?: PtyOptions): Promise<Response>;
    }
  >;
};

/** Typed wrapper around the SDK's `getSandbox()` that returns a `BridgeSandbox`. */
export function getBridgeSandbox<T extends Sandbox<any>>(
  ns: DurableObjectNamespace<T>,
  containerUUID: string
): BridgeSandbox {
  return _getSandbox(ns, containerUUID) as unknown as BridgeSandbox;
}
