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
  currentRuntime?: Pick<
    CurrentRuntimeIdentity,
    'get' | 'markStarted' | 'assertActive'
  >;
  currentLifetime?: Pick<
    CurrentSandboxLifetime,
    'getOrCreate' | 'assertCurrent'
  >;
}

export interface TunnelLifecycleSnapshot {
  runtime?: RuntimeIdentity;
  lifetime?: SandboxLifetime;
}

const TUNNEL_GET_MAX_RECOVERY_ATTEMPTS = 2;

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
          retryable: true,
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

  async runGetWithRecovery<T>(attempt: () => Promise<T>): Promise<T> {
    let recoveryAttempts = 0;
    while (true) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof OperationInterruptedError)) throw error;
        if (!error.context.retryable) throw error;
        if (recoveryAttempts >= TUNNEL_GET_MAX_RECOVERY_ATTEMPTS) {
          throw createTunnelRecoveryExhaustedError(error, recoveryAttempts);
        }
        recoveryAttempts += 1;
      }
    }
  }

  async #captureRuntime(): Promise<RuntimeIdentity | undefined> {
    const currentRuntime = this.#host.currentRuntime;
    if (!currentRuntime) return undefined;
    const runtime =
      (await currentRuntime.get()) ?? (await currentRuntime.markStarted());
    await currentRuntime.assertActive(runtime);
    return runtime;
  }
}

function createTunnelInterruptedError(params: {
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

function createTunnelRecoveryExhaustedError(
  error: OperationInterruptedError,
  recoveryAttempts: number
): OperationInterruptedError {
  return new OperationInterruptedError({
    message: 'Tunnel operation recovery attempts were exhausted',
    code: ErrorCode.OPERATION_INTERRUPTED,
    httpStatus: 409,
    context: {
      ...error.context,
      reason: 'recovery_exhausted',
      retryable: true,
      recoveryAttempts,
      maxRecoveryAttempts: TUNNEL_GET_MAX_RECOVERY_ATTEMPTS
    },
    timestamp: new Date().toISOString(),
    suggestion: 'Retry tunnels.get() with the same port and options.'
  });
}
