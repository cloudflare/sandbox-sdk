import type {
  CurrentRuntimeIdentity,
  RuntimeIdentity
} from '../current-runtime-identity';
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import { ErrorCode, OperationInterruptedError } from '../errors';
import type {
  CurrentSandboxLifetime,
  SandboxLifetime
} from '../sandbox-lifetime';
import { SandboxLifetimeChangedError } from '../sandbox-lifetime';

export interface TunnelLifecycleHost {
  currentRuntime?: Pick<CurrentRuntimeIdentity, 'get' | 'assertActive'>;
  currentLifetime?: Pick<
    CurrentSandboxLifetime,
    'getOrCreate' | 'assertCurrent'
  >;
}

export interface TunnelLifecycleSnapshot {
  runtime?: RuntimeIdentity;
  lifetime?: SandboxLifetime;
}

export class TunnelOperationLifecycle {
  readonly #host: TunnelLifecycleHost;

  constructor(host: TunnelLifecycleHost) {
    this.#host = host;
  }

  async capture(): Promise<TunnelLifecycleSnapshot> {
    return {
      runtime: await this.#captureRuntime(),
      lifetime: await this.#host.currentLifetime?.getOrCreate()
    };
  }

  async requireRuntime(
    snapshot: TunnelLifecycleSnapshot,
    phase: string,
    admitted: true | 'unknown'
  ): Promise<TunnelLifecycleSnapshot> {
    if (snapshot.runtime) return snapshot;
    const runtime = await this.#captureRuntime();
    if (runtime) {
      return { ...snapshot, runtime };
    }
    if (this.#host.currentRuntime) {
      throw createTunnelInterruptedError({
        reason: 'runtime_replaced',
        phase,
        admitted,
        retryable: false,
        message: 'Tunnel operation was interrupted by a runtime replacement'
      });
    }
    return snapshot;
  }

  async assertActive(
    snapshot: TunnelLifecycleSnapshot,
    phase: string,
    admitted: true | 'unknown'
  ): Promise<void> {
    try {
      if (snapshot.runtime) {
        await this.#host.currentRuntime?.assertActive(snapshot.runtime);
      }
      if (snapshot.lifetime) {
        await this.#host.currentLifetime?.assertCurrent(snapshot.lifetime);
      }
    } catch (error) {
      if (error instanceof RuntimeIdentityInactiveError) {
        throw createTunnelInterruptedError({
          reason: 'runtime_replaced',
          phase,
          admitted,
          retryable: false,
          message: 'Tunnel operation was interrupted by a runtime replacement'
        });
      }
      if (error instanceof SandboxLifetimeChangedError) {
        throw createTunnelInterruptedError({
          reason: 'sandbox_lifetime_changed',
          phase,
          admitted,
          retryable: false,
          message:
            'Tunnel operation was interrupted by a sandbox lifetime change'
        });
      }
      throw error;
    }
  }

  async #captureRuntime(): Promise<RuntimeIdentity | undefined> {
    const currentRuntime = this.#host.currentRuntime;
    if (!currentRuntime) return undefined;
    const runtime = await currentRuntime.get();
    if (!runtime) return undefined;
    await currentRuntime.assertActive(runtime);
    return runtime;
  }
}

export function createTunnelInterruptedError(params: {
  reason: 'runtime_replaced' | 'sandbox_lifetime_changed';
  phase: string;
  admitted: true | 'unknown';
  retryable: boolean;
  message: string;
}): OperationInterruptedError {
  return new OperationInterruptedError({
    message: params.message,
    code: ErrorCode.OPERATION_INTERRUPTED,
    httpStatus: 409,
    context: {
      reason: params.reason,
      operation: 'tunnel.get',
      phase: params.phase,
      admitted: params.admitted,
      retryable: params.retryable
    },
    timestamp: new Date().toISOString(),
    suggestion: 'Retry tunnels.get() with the same port and options.'
  });
}
