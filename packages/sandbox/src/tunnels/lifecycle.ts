import { ErrorCode, OperationInterruptedError } from '../errors';

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
