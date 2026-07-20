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
import type { RuntimeIdentity } from '../runtime';
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
    private readonly logger: Logger,
    private readonly expectedRuntime?: RuntimeIdentity,
    private readonly getCurrentRuntime?: () =>
      | RuntimeIdentity
      | null
      | Promise<RuntimeIdentity | null>
  ) {
    super();
  }

  bindRuntime(runtime: RuntimeIdentity): SandboxControlCallbackImpl {
    return new SandboxControlCallbackImpl(
      this.getHandler,
      this.logger,
      runtime,
      this.getCurrentRuntime
    );
  }

  async onTunnelRunExit(event: TunnelRunExitEvent): Promise<void> {
    const currentRuntime = this.getCurrentRuntime
      ? await this.getCurrentRuntime()
      : null;
    if (
      this.expectedRuntime &&
      (!currentRuntime ||
        currentRuntime.id !== this.expectedRuntime.id ||
        currentRuntime.runtimeIncarnationID !==
          this.expectedRuntime.runtimeIncarnationID)
    ) {
      this.logger.debug('onTunnelRunExit: stale runtime callback ignored', {
        tunnelId: event.tunnelId,
        runId: event.runId,
        mode: event.mode,
        port: event.port
      });
      return;
    }
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
