import type { OperationInterruptedReason } from '@repo/shared/errors';
import { RuntimeIdentityInactiveError } from '../current-runtime-identity';
import {
  ErrorCode,
  OperationInterruptedError,
  RPCTransportError
} from '../errors';
import { SandboxLifetimeChangedError } from '../sandbox-lifetime';

export const TUNNEL_GET_MAX_RECOVERY_ATTEMPTS = 2;

export function runtimeRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

export function createTunnelInterruptedError(params: {
  reason: OperationInterruptedReason;
  phase: string;
  admitted: boolean | 'unknown';
  retryable: boolean;
  recoveryAttempts?: number;
  maxRecoveryAttempts?: number;
}): OperationInterruptedError {
  return new OperationInterruptedError({
    message:
      params.reason === 'recovery_exhausted'
        ? 'Tunnel recovery attempts were exhausted'
        : 'Tunnel operation was interrupted by a sandbox runtime change',
    code: ErrorCode.OPERATION_INTERRUPTED,
    httpStatus: 409,
    context: {
      reason: params.reason,
      operation: 'tunnel.get',
      phase: params.phase,
      admitted: params.admitted,
      retryable: params.retryable,
      ...(params.recoveryAttempts !== undefined && {
        recoveryAttempts: params.recoveryAttempts
      }),
      ...(params.maxRecoveryAttempts !== undefined && {
        maxRecoveryAttempts: params.maxRecoveryAttempts
      })
    },
    timestamp: new Date().toISOString(),
    suggestion: params.retryable
      ? 'Retry tunnels.get() for the same port so the SDK can establish a fresh tunnel run.'
      : 'Start a new tunnels.get() call only if this tunnel is still desired for the current sandbox.'
  });
}

export function translateTunnelInterruption(
  error: unknown,
  phase: string,
  admitted: boolean | 'unknown'
): OperationInterruptedError | null {
  if (error instanceof OperationInterruptedError) {
    return error;
  }
  if (error instanceof RuntimeIdentityInactiveError) {
    return createTunnelInterruptedError({
      reason: 'runtime_replaced',
      phase,
      admitted,
      retryable: true
    });
  }
  if (error instanceof SandboxLifetimeChangedError) {
    return createTunnelInterruptedError({
      reason: 'sandbox_lifetime_changed',
      phase,
      admitted,
      retryable: false
    });
  }
  if (error instanceof RPCTransportError) {
    return createTunnelInterruptedError({
      reason: 'transport_disposed',
      phase,
      admitted: 'unknown',
      retryable: true
    });
  }
  return null;
}
