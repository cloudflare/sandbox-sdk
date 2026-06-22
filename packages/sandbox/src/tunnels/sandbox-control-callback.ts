/**
 * `SandboxControlCallbackImpl` — capnweb `RpcTarget` the DO exposes as
 * `localMain` on the container-control session. The container reaches
 * it via `session.getRemoteMain<SandboxControlCallback>()` to push
 * control-plane events back to the DO.
 */

import type { Logger, SandboxControlCallback } from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { TunnelExitHandler } from './rpc-target';

export class SandboxControlCallbackImpl
  extends RpcTarget
  implements SandboxControlCallback
{
  constructor(
    /**
     * Accessor (not a direct reference) so eviction can swap the handler
     * without re-binding the capnweb session. Returns `null` if the handler hasn't been constructed
     * yet — the callback no-ops in that case, which is fine because
     * the container only reaches us via a live session and a live
     * session implies a sandbox that is about to construct (or has
     * just constructed) its handler on the next access.
     */
    private readonly getHandler: () => TunnelExitHandler | null,
    private readonly logger: Logger
  ) {
    super();
  }

  async onTunnelExit(
    id: string,
    port: number,
    exitCode: number | null
  ): Promise<void> {
    const handler = this.getHandler();
    if (!handler) {
      this.logger.debug('onTunnelExit: no handler bound; ignoring', {
        id,
        port,
        exitCode
      });
      return;
    }
    await handler(id, port, exitCode);
  }
}
