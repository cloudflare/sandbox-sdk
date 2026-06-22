import { RpcTarget } from 'cloudflare:workers';
import type { TunnelInfo, TunnelOptions } from '@repo/shared';
import {
  type TunnelExitHandler,
  TunnelService,
  type TunnelServiceHost,
  type TunnelsHandle,
  type TunnelsHandler
} from './tunnel-service';

export { pruneTunnelsForRestart } from './restart';
export type { TunnelsStorage, TunnelsStorageTxn } from './storage';
export type {
  TunnelExitHandler,
  TunnelServiceHost,
  TunnelsHandle,
  TunnelsHandler
} from './tunnel-service';

/**
 * Workers RPC adapter for the public `sandbox.tunnels` namespace.
 * The service owns tunnel lifecycle and resource invariants; this class
 * only provides a `RpcTarget` shape for Workers RPC compatibility.
 */
class TunnelsRpcTarget extends RpcTarget implements TunnelsHandler {
  constructor(private readonly service: TunnelService) {
    super();
  }

  get(port: number, options?: TunnelOptions): Promise<TunnelInfo> {
    return this.service.get(port, options);
  }

  list(): Promise<TunnelInfo[]> {
    return this.service.list();
  }

  destroy(portOrInfo: number | TunnelInfo): Promise<void> {
    return this.service.destroy(portOrInfo);
  }
}

export function createTunnelsHandle(host: TunnelServiceHost): TunnelsHandle {
  const service = new TunnelService(host);
  const tunnels = new TunnelsRpcTarget(service);

  return {
    tunnels,
    handleTunnelExit: (id, port, exitCode, tunnelRunId) =>
      service.onTunnelExit(id, port, exitCode, tunnelRunId),
    destroyAll: () => service.destroyAll(),
    resumeCleanup: () => service.resumeCleanup(),
    onRuntimeStart: () => service.onRuntimeStart(),
    onRuntimeStop: () => service.onRuntimeStop(),
    clearDurableStateAfterDestroy: () => service.clearDurableStateAfterDestroy()
  };
}
