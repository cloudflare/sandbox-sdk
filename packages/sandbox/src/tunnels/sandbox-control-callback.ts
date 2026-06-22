/**
 * `SandboxControlCallbackImpl` — capnweb `RpcTarget` the DO exposes as
 * `localMain` on the container-control session. The container reaches
 * it via `session.getRemoteMain<SandboxControlCallback>()` to push
 * tunnel-run events back to the DO.
 */

import type {
  Logger,
  SandboxControlCallback,
  TunnelRunExitEvent
} from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { TunnelExitHandler } from './rpc-target';

export class SandboxControlCallbackImpl
  extends RpcTarget
  implements SandboxControlCallback
{
  constructor(
    /**
     * Accessor (not a direct reference) so eviction can swap the handler
     * while keeping the capnweb session bound. Returns `null` if the
     * handler has not been constructed yet; callback methods no-op in
     * that window.
     */
    private readonly getHandler: () => TunnelExitHandler | null,
    private readonly logger: Logger
  ) {
    super();
  }

  async onTunnelRunExit(event: TunnelRunExitEvent): Promise<void> {
    const handler = this.getHandler();
    if (!handler) {
      this.logger.debug('onTunnelRunExit: no handler bound; ignoring', {
        tunnelId: event.tunnelId,
        runId: event.runId,
        mode: event.mode,
        port: event.port,
        exitCode: event.exitCode
      });
      return;
    }
    await handler(event.tunnelId, event.port, event.exitCode, event.runId);
  }
}
