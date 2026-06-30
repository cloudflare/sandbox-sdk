import type {
  ContainerVersionMismatchContext,
  ErrorResponse,
  OperationInterruptedContext,
  RPCTransportContext,
  RPCTransportErrorKind
} from '@repo/shared/errors';
import { ErrorCode, getHttpStatus, getSuggestion } from '@repo/shared/errors';
import { createErrorFromResponse } from '../errors/adapter';
import { SandboxError } from '../errors/classes';

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/** Legacy JSON-in-message payload shape — see `translateRPCError`. */
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

/**
 * Translate a capnweb-propagated error into a typed SandboxError.
 *
 * Two wire formats are supported for backward compatibility with older
 * container images:
 *
 *  1. Propagated error properties (capnweb >= 0.8.0). The container throws a
 *     `ServiceError`-shaped object with own enumerable `code` and `details`
 *     properties. capnweb walks `Object.keys()` and reconstructs those fields
 *     on the SDK side.
 *  2. Legacy JSON-encoded message. Older containers encoded the structured
 *     payload as a JSON string in `error.message`.
 *
 * The JSON-fallback branch can be removed once all older container images are
 * no longer in service.
 */
export interface RPCTranslationContext {
  /** Public operation name, e.g. `commands.execute` or `files.writeFile`. */
  operation?: string;
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

    // Format (1): propagated error properties. Distinguish from arbitrary
    // Node/system errors (e.g. `Error.code === 'ENOENT'`) by checking the
    // code against the ErrorCode registry.
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

    // Format (2): legacy JSON-encoded structured error in `message`.
    let payload: RPCErrorPayload | undefined;
    try {
      payload = JSON.parse(error.message) as RPCErrorPayload;
    } catch {
      // Not a JSON-encoded structured error. Fall through to transport-
      // level classification below.
    }
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
    // Map capnweb / DeferredTransport messages onto structured SDK errors
    // so consumers get public `code` and context fields.
    const transportResponse = buildTransportErrorResponse(error);
    const interruptedResponse = buildInterruptedOperationResponse(
      transportResponse,
      context
    );
    throw createErrorFromResponse(
      (interruptedResponse ?? transportResponse) as unknown as ErrorResponse,
      { cause: error }
    );
  }
  // Non-Error throw (rare — capnweb's deserializer always constructs Error
  // instances, but defensively handle anything else that bubbles up).
  // Coerce to an Error so the kind=unknown context still has a usable
  // originalMessage, and preserve the raw value as `cause`.
  const wrapped = new Error(String(error));
  throw createErrorFromResponse(
    buildTransportErrorResponse(wrapped) as unknown as ErrorResponse,
    { cause: error }
  );
}

/**
 * Inspect a transport-level Error's message and produce the ErrorResponse
 * that becomes an RPCTransportError. Pattern strings are pinned to the exact
 * messages emitted by capnweb's WebSocket transport (see capnweb's
 * src/websocket.ts) and our DeferredTransport in container-control/connection.ts —
 * notably the trailing period in `WebSocket connection failed.` matches
 * capnweb verbatim. The DeferredTransport tests in
 * tests/container-connection.test.ts pin the literal strings.
 */
function buildTransportErrorResponse(
  error: Error
): ErrorResponse<RPCTransportContext> {
  const message = error.message;
  const errorName = error.name;
  let kind: RPCTransportErrorKind = 'unknown';
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  // First pass: classify by `error.name`. capnweb preserves the name
  // across the wire for the standard built-ins (see ERROR_TYPES in
  // capnweb's serialize.ts), and an unambiguous name beats substring
  // matching on a free-form message. It also handles the cross-realm
  // `instanceof` trap: a TypeError raised inside capnweb's serializer lives
  // in capnweb's realm, not the SDK's.
  if (errorName === 'TypeError') {
    // Only DeferredTransport / capnweb's WebSocket transport raises a
    // TypeError on the receive path — always a non-string frame.
    kind = 'invalid_frame';
  } else if (errorName === 'SyntaxError') {
    // capnweb's readLoop calls JSON.parse on each incoming frame; if the
    // peer sends garbage that's not parseable JSON, the SyntaxError flows
    // through abort() to every in-flight call.
    kind = 'protocol_error';
  } else {
    // Second pass: plain Errors. capnweb's transport layer and our
    // DeferredTransport both emit unnamed Errors with these specific
    // messages; the message is the only signal we have.
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
      // ContainerControlConnection.doConnect throws this when the HTTP upgrade
      // returns a non-101 status.
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

/**
 * Reclassify retry-unsafe transport failures as interrupted operations when
 * they happen after a specific RPC operation has been admitted to the control
 * channel.
 */
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
    phase: 'rpc_call',
    admitted: 'unknown',
    retryable: false
  };
  const action =
    kind === 'session_disposed' ? 'was closing' : 'closed unexpectedly';

  return {
    code: ErrorCode.OPERATION_INTERRUPTED,
    message: `Sandbox operation ${context.operation} was interrupted while the connection to the sandbox container ${action}`,
    context: interruptedContext,
    httpStatus: getHttpStatus(ErrorCode.OPERATION_INTERRUPTED),
    suggestion: getSuggestion(
      ErrorCode.OPERATION_INTERRUPTED,
      interruptedContext as unknown as Record<string, unknown>
    ),
    timestamp: new Date().toISOString()
  };
}

/** Build a structured ErrorResponse for SDK/container protocol mismatch. */
function buildVersionMismatchError(
  context: ContainerVersionMismatchContext
): ErrorResponse<ContainerVersionMismatchContext> {
  const message =
    context.reason === 'missing_handshake'
      ? 'The deployed sandbox container is too old to report its version to this SDK. Redeploy with a container image that matches your @cloudflare/sandbox version.'
      : `The deployed sandbox container is not compatible with this SDK (SDK control protocol ${context.supportedProtocolVersion}, container control protocol ${context.containerProtocolVersion}). Redeploy with a container image that matches your @cloudflare/sandbox version.`;
  return {
    code: ErrorCode.CONTAINER_VERSION_MISMATCH,
    message,
    context,
    httpStatus: getHttpStatus(ErrorCode.CONTAINER_VERSION_MISMATCH),
    suggestion: getSuggestion(
      ErrorCode.CONTAINER_VERSION_MISMATCH,
      context as unknown as Record<string, unknown>
    ),
    timestamp: new Date().toISOString()
  };
}

export function throwVersionMismatch(
  context: ContainerVersionMismatchContext,
  cause?: unknown
): never {
  throw createErrorFromResponse(
    buildVersionMismatchError(context) as unknown as ErrorResponse,
    cause === undefined ? undefined : { cause }
  );
}
