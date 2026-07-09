/** Error translation for container control RPC calls. */

import {
  ErrorCode,
  type ErrorResponse,
  getHttpStatus,
  getSuggestion,
  type OperationInterruptedContext,
  type RPCTransportContext,
  type RPCTransportErrorKind
} from '@repo/shared/errors';
import { createErrorFromResponse } from '../errors/adapter';
import { SandboxError } from '../errors/classes';

interface RPCErrorPayload {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

function isLocalSandboxError(
  error: Error
): error is Error & { errorResponse: ErrorResponse } {
  if (!('errorResponse' in error)) return false;
  const response = error.errorResponse as Partial<ErrorResponse> | undefined;
  return (
    typeof response?.code === 'string' &&
    Object.hasOwn(ErrorCode, response.code) &&
    typeof response.message === 'string' &&
    typeof response.httpStatus === 'number' &&
    typeof response.timestamp === 'string' &&
    typeof response.context === 'object' &&
    response.context !== null
  );
}

export interface RPCTranslationContext {
  operation?: string;
  translateTransportErrorsAsInterruptions?: boolean;
}

export function translateRPCError(
  error: unknown,
  context: RPCTranslationContext = {}
): never {
  if (error instanceof SandboxError) throw error;

  if (error instanceof Error) {
    if (isLocalSandboxError(error)) {
      throw error;
    }

    const propagated = error as Error & {
      code?: unknown;
      details?: unknown;
    };
    if (
      typeof propagated.code === 'string' &&
      Object.hasOwn(ErrorCode, propagated.code)
    ) {
      const code = propagated.code as ErrorCode;
      const context =
        propagated.details && typeof propagated.details === 'object'
          ? (propagated.details as Record<string, unknown>)
          : {};
      throw createErrorFromResponse({
        code,
        message: error.message,
        context,
        httpStatus: getHttpStatus(code),
        timestamp: new Date().toISOString()
      });
    }

    let payload: RPCErrorPayload | undefined;
    try {
      payload = JSON.parse(error.message) as RPCErrorPayload;
    } catch {}
    if (
      payload &&
      typeof payload.code === 'string' &&
      typeof payload.message === 'string'
    ) {
      throw createErrorFromResponse({
        code: payload.code as ErrorCode,
        message: payload.message,
        context: payload.context ?? {},
        httpStatus: getHttpStatus(payload.code as ErrorCode),
        timestamp: new Date().toISOString()
      });
    }

    const transportResponse = buildTransportErrorResponse(error);
    const interruptedResponse =
      context.translateTransportErrorsAsInterruptions === false
        ? null
        : buildInterruptedOperationResponse(transportResponse, context);
    throw createErrorFromResponse(
      (interruptedResponse ?? transportResponse) as unknown as ErrorResponse,
      { cause: error }
    );
  }

  const wrapped = new Error(String(error));
  throw createErrorFromResponse(
    buildTransportErrorResponse(wrapped) as unknown as ErrorResponse,
    { cause: error }
  );
}

function buildTransportErrorResponse(
  error: Error
): ErrorResponse<RPCTransportContext> {
  const message = error.message;
  const errorName = error.name;
  let kind: RPCTransportErrorKind = 'unknown';
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  if (errorName === 'TypeError') {
    kind = 'invalid_frame';
  } else if (errorName === 'SyntaxError') {
    kind = 'protocol_error';
  } else {
    const peerCloseMatch = message.match(
      /^Peer closed WebSocket: (\d+) ?(.*)$/
    );
    if (peerCloseMatch) {
      kind = 'peer_closed';
      closeCode = Number(peerCloseMatch[1]);
      closeReason = peerCloseMatch[2] || undefined;
    } else if (message === 'WebSocket connection failed.') {
      kind = 'connection_failed';
    } else if (message.startsWith('WebSocket upgrade failed')) {
      kind = 'upgrade_failed';
    } else if (message === 'No WebSocket in upgrade response') {
      kind = 'upgrade_failed';
    } else if (
      message === 'RPC session was shut down by disposing the main stub' ||
      message === 'RPC was canceled because the RpcPromise was disposed.'
    ) {
      kind = 'session_disposed';
    }
  }

  const context: RPCTransportContext = {
    kind,
    originalMessage: message,
    errorName,
    ...(closeCode !== undefined ? { closeCode } : {}),
    ...(closeReason !== undefined ? { closeReason } : {})
  };
  return {
    code: ErrorCode.RPC_TRANSPORT_ERROR,
    message,
    context,
    httpStatus: getHttpStatus(ErrorCode.RPC_TRANSPORT_ERROR),
    suggestion: getSuggestion(
      ErrorCode.RPC_TRANSPORT_ERROR,
      context as unknown as Record<string, unknown>
    ),
    timestamp: new Date().toISOString()
  };
}

function buildInterruptedOperationResponse(
  transportResponse: ErrorResponse<RPCTransportContext>,
  context: RPCTranslationContext
): ErrorResponse<OperationInterruptedContext> | null {
  if (!context.operation) return null;
  const { kind } = transportResponse.context;
  if (
    kind !== 'session_disposed' &&
    kind !== 'peer_closed' &&
    kind !== 'connection_failed'
  ) {
    return null;
  }

  const interruptedContext: OperationInterruptedContext = {
    reason:
      kind === 'session_disposed' ? 'transport_disposed' : 'runtime_replaced',
    operation: context.operation,
    admitted: 'unknown',
    retryable: false
  };
  const action =
    kind === 'session_disposed' ? 'was closing' : 'closed unexpectedly';

  return {
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: `Sandbox operation ${context.operation} was interrupted while the runtime connection ${action}`,
    context: interruptedContext,
    httpStatus: getHttpStatus(ErrorCode.OPERATION_INTERRUPTED),
    suggestion: getSuggestion(
      ErrorCode.OPERATION_INTERRUPTED,
      interruptedContext as unknown as Record<string, unknown>
    ),
    timestamp: new Date().toISOString()
  };
}
