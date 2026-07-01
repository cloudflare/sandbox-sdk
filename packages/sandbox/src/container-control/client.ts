/**
 * SandboxClient implementation backed by direct capnweb RPC calls.
 *
 * The server exposes each domain (commands, files, processes, etc.) as a
 * nested RpcTarget. capnweb returns typed stubs for these so the client
 * can use `rpc.commands`, `rpc.files`, etc. directly without any
 * per-method boilerplate.
 *
 * Manages its own connection lifecycle: creates a fresh ContainerControlConnection
 * on demand and disconnects it after a configurable idle period. Idle
 * detection uses capnweb's `RpcSession.getStats()` which naturally tracks
 * all in-flight RPC calls, streams, and peer-held references — no manual
 * operation counting required.
 *
 * ---------------------------------------------------------------------------
 * How capnweb tracks in-flight work (and why we poll getStats)
 * ---------------------------------------------------------------------------
 *
 * Every capnweb session maintains two tables: `imports` (references the
 * peer is exposing to us) and `exports` (references we are exposing to the
 * peer). `getStats()` returns the live count of each.
 *
 * At rest, both contain exactly one entry — the bootstrap "main" stub each
 * side exposes to reach the other. We treat `imports <= 1 && exports <= 1`
 * as the idle baseline.
 *
 * Each kind of in-flight work bumps these counts:
 *
 *   - **Pending RPC call.** `sendCall()` allocates a new import slot for
 *     the return value; the slot is released when the response arrives and
 *     the caller disposes the promise. So a regular call shows up as
 *     `imports = 2` for its lifetime.
 *
 *   - **Returned ReadableStream.** When the peer (the container) returns a
 *     `ReadableStream` from an RPC method (e.g. `commands.executeStream`),
 *     capnweb serializes it via `createPipe()`: the *server* allocates an
 *     import slot, pumps `readable.pipeTo(writable)` over the wire, and
 *     only releases the slot in `pipeTo().finally(() => hook.dispose())`
 *     once the source stream ends or is canceled. On *our* side this
 *     materializes as an export entry held for the same duration. So an
 *     active stream return keeps `exports = 2` even after the RPC promise
 *     that delivered the stream has already resolved.
 *
 *   - **Stubs / RpcTargets passed across the wire.** Anything the peer
 *     hands us (or we hand the peer) that isn't a plain value adds an
 *     entry until both sides dispose it.
 *
 * The practical consequence for sleepAfter: the per-call promise lifecycle
 * is *not* a reliable signal of "the container is done with this work".
 * `commands.executeStream(...)` resolves in milliseconds with a stream
 * reference, but the container then writes to that stream for seconds. The
 * only signal that survives across the promise boundary is the export
 * entry — i.e. `getStats()`.
 *
 * So the strategy is:
 *
 *   1. Run a periodic poll while the WebSocket is connected.
 *   2. While `imports > 1 || exports > 1`, treat the session as busy:
 *      hold the DO's `inflightRequests` counter at >= 1 and renew the
 *      activity timeout each tick so the sleepAfter alarm gets pushed
 *      forward.
 *   3. When the poll observes idle, decrement back to 0, renew once more
 *      to reset the inactivity window from now, and schedule the WS
 *      disconnect.
 *
 * On top of that, every RPC method invocation also fires `onActivity`
 * synchronously at call start. That keeps fast calls from racing the
 * poll cadence: even if a call begins and ends entirely between two
 * polls, the activity timeout was renewed at the start.
 */

import type {
  Logger,
  SandboxBackupAPI,
  SandboxCommandsAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxInterpreterAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxTransport,
  SandboxTunnelsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import {
  type ContainerUnavailableContext,
  ErrorCode,
  type ErrorResponse,
  getHttpStatus,
  getSuggestion,
  type OperationInterruptedContext,
  type RPCTransportContext,
  type RPCTransportErrorKind
} from '@repo/shared/errors';
import type { SandboxClient } from '../clients/sandbox-client';
import { createErrorFromResponse } from '../errors/adapter';
import { SandboxError } from '../errors/classes';
import {
  ContainerControlConnection,
  type ContainerControlConnectionOptions
} from './connection';
import { withSpan } from './tracing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Close the idle capnweb WebSocket promptly so the DO can sleep. */
const DEFAULT_IDLE_DISCONNECT_MS = 1_000;

/**
 * How often the busy/idle poller samples `getStats()`.
 *
 * Sets two worst-case bounds:
 *
 *   1. **Idle-detection lag.** Time between the session going idle on
 *      the wire and the DO observing it (and arming the disconnect).
 *      Bounded by `pollInterval`.
 *   2. **Activity-renewal lag while busy.** While a stream is active we
 *      renew the DO's activity timeout once per tick. The alarm could
 *      fire as late as `sleepAfter` after the last renew, so the
 *      effective margin against a mid-stream sleep is
 *      `sleepAfter - pollInterval`.
 *
 * **Invariant: `pollInterval` must be comfortably less than the
 * smallest configurable `sleepAfter`.** Aim for at least 2-3× headroom.
 * The minimum `sleepAfter` exercised by the E2E suite is 3s, so 1s gives
 * 3× margin and at least two renewals during a 3s window. If a smaller
 * `sleepAfter` is ever supported, drop this proportionally.
 */
const BUSY_POLL_INTERVAL_MS = 1_000;

/**
 * Baseline getStats() values for an idle session. The bootstrap stub on each
 * side accounts for 1 import and 1 export.
 */
const IDLE_IMPORT_THRESHOLD = 1;
const IDLE_EXPORT_THRESHOLD = 1;

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/** Legacy JSON-in-message payload shape — see `translateRPCError`. */
interface RPCErrorPayload {
  code: string;
  message: string;
  context?: Record<string, unknown>;
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
  /**
   * Error captured by `ContainerControlConnection` during connection startup
   * (e.g. a platform container-allocation failure). When the RPC call rejects
   * with a generic capnweb disposal / connection-failure error caused by that
   * same startup abort, this captured error is the real, actionable cause and
   * is preferred over the masking transport error.
   */
  connectionError?: unknown;
  /**
   * Whether the capnweb session ever established a live connection to a
   * running container during the current connection's lifetime.
   *
   * `OPERATION_INTERRUPTED` means "the operation was admitted to a running
   * runtime, then interrupted." If the session never established (the
   * container never started — e.g. no instance available), that framing is
   * wrong: the operation was never admitted. In that case we surface the
   * thrown transport error directly instead of masking it as an interruption.
   */
  sessionEstablished?: boolean;
}

export function translateRPCError(
  error: unknown,
  context: RPCTranslationContext = {}
): never {
  // Preserve locally-created SDK errors. These already carry the correct
  // code, context, and HTTP status. Re-wrapping them would create a new
  // instance with an empty context (no `details` property) and lose the
  // original structured information.
  if (error instanceof SandboxError) throw error;

  if (error instanceof Error) {
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
    // Map capnweb / DeferredTransport messages onto structured lifecycle
    // errors so consumers can branch on public SDK contracts instead of
    // substring-matching transport internals.
    const transportResponse = buildTransportErrorResponse(error);
    // If this call rejected because a connection-startup failure aborted the
    // transport, prefer that captured error — it carries the real, actionable
    // cause (e.g. CONTAINER_UNAVAILABLE) instead of the generic disposal /
    // connection-failure message capnweb raises on the queued call.
    const captured = maybePreferConnectionError(transportResponse, context);
    if (captured) throw captured;
    // If the session never established a live connection, don't map to
    // OPERATION_INTERRUPTED (nothing was admitted, so "interrupted" is
    // misleading) and don't leak the raw capnweb disposal string. A
    // teardown-family error here means the container was never reachable —
    // surface a clean, retryable CONTAINER_UNAVAILABLE. `sessionEstablished`
    // defaults to undefined for callers that don't track it (e.g. direct unit
    // tests), preserving the prior behavior in that case.
    if (context.sessionEstablished === false) {
      const neverConnected = buildNeverConnectedUnavailableResponse(
        transportResponse,
        context
      );
      throw createErrorFromResponse(
        (neverConnected ?? transportResponse) as unknown as ErrorResponse,
        { cause: error }
      );
    }
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
 * messages emitted by capnweb's WebSocketTransport (see capnweb's
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
    // Only DeferredTransport / capnweb's WebSocketTransport raise a
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
 * When a queued RPC call rejects with a transport error that a connection
 * abort could have caused (session disposed, connection failed, upgrade
 * failed, or peer closed), and the connection captured a real startup error,
 * return that captured error in preference to the masking transport error.
 *
 * The captured error is accepted whether it is:
 *   - a same-realm `SandboxError` (surfaced as-is), or
 *   - any structured, error-like value carrying a recognized `code` — e.g. a
 *     raw or cross-realm error decorated with `code: 'CONTAINER_UNAVAILABLE'`
 *     and optional `context`/`details`/`message`. Such values are rehydrated
 *     via `createErrorFromResponse` so the caller still receives a proper
 *     typed SandboxError instead of a masked OperationInterruptedError.
 *
 * Anything without a recognized code is ignored so the caller falls back to
 * normal transport classification.
 */
function maybePreferConnectionError(
  transportResponse: ErrorResponse<RPCTransportContext>,
  context: RPCTranslationContext
): SandboxError | null {
  const captured = context.connectionError;
  if (!captured) return null;
  const { kind } = transportResponse.context;
  if (
    kind !== 'session_disposed' &&
    kind !== 'connection_failed' &&
    kind !== 'upgrade_failed' &&
    kind !== 'peer_closed'
  ) {
    return null;
  }

  // Same-realm typed error: surface as-is.
  if (captured instanceof SandboxError) {
    return captured;
  }

  // Structured, error-like value (raw/cross-realm) carrying a recognized
  // code. Rehydrate into a typed SandboxError. Reads `context` or `details`
  // for the structured payload, matching the two wire formats handled by
  // `translateRPCError`.
  const shape = captured as {
    code?: unknown;
    message?: unknown;
    context?: unknown;
    details?: unknown;
  } | null;
  if (
    shape &&
    typeof shape.code === 'string' &&
    Object.hasOwn(ErrorCode, shape.code)
  ) {
    const code = shape.code as ErrorCode;
    const structured =
      shape.context && typeof shape.context === 'object'
        ? (shape.context as Record<string, unknown>)
        : shape.details && typeof shape.details === 'object'
          ? (shape.details as Record<string, unknown>)
          : {};
    const message = typeof shape.message === 'string' ? shape.message : code;
    return createErrorFromResponse(
      {
        code,
        message,
        context: structured,
        httpStatus: getHttpStatus(code),
        suggestion: getSuggestion(code, structured as Record<string, unknown>),
        timestamp: new Date().toISOString()
      },
      { cause: captured }
    ) as SandboxError;
  }

  return null;
}

/**
 * When the session never established a live connection and a queued RPC call
 * rejects with a teardown-family transport error (disposed / connection
 * failed / peer closed), surface a clean, retryable `ContainerUnavailableError`
 * instead of the raw capnweb string (e.g. "RPC session was shut down by
 * disposing the main stub").
 *
 * Reaching this point means: the container never became reachable (so no
 * OPERATION_INTERRUPTED — nothing was admitted) AND no structured connection
 * error was captured (so `maybePreferConnectionError` didn't fire). That's the
 * Durable Object being torn down/evicted mid-startup under capacity pressure
 * before `doConnect` recorded a cause — which is, from the caller's view, the
 * container being unavailable. Retryable, with the raw transport message
 * preserved as `originalMessage` for diagnostics.
 */
function buildNeverConnectedUnavailableResponse(
  transportResponse: ErrorResponse<RPCTransportContext>,
  context: RPCTranslationContext
): ErrorResponse<ContainerUnavailableContext> | null {
  if (context.sessionEstablished !== false) return null;
  const { kind } = transportResponse.context;
  if (
    kind !== 'session_disposed' &&
    kind !== 'connection_failed' &&
    kind !== 'peer_closed'
  ) {
    return null;
  }
  const ctx: ContainerUnavailableContext = {
    reason: 'container_unreachable',
    retryable: true,
    originalMessage: transportResponse.context.originalMessage
  };
  return {
    code: ErrorCode.CONTAINER_UNAVAILABLE,
    message:
      'The sandbox container was unavailable: the connection was torn down before it became reachable. Retry the operation.',
    context: ctx,
    httpStatus: getHttpStatus(ErrorCode.CONTAINER_UNAVAILABLE),
    suggestion: getSuggestion(
      ErrorCode.CONTAINER_UNAVAILABLE,
      ctx as unknown as Record<string, unknown>
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
    phase: 'rpc_call',
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

/**
 * Wrap a capnweb RPC stub so that every method call translates errors
 * from the JSON wire format into typed SandboxError instances and signals
 * activity at call start.
 *
 * `onCallStarted` fires synchronously when an RPC method is invoked, and
 * `onCallSettled` fires when the returned promise settles. The
 * ContainerControlClient uses these hooks to keep the session marked busy
 * even if capnweb stats briefly report the bootstrap baseline while a call is
 * still pending.
 *
 * A method whose returned promise resolves with a `ReadableStream` is *not*
 * finished when the promise settles — capnweb keeps the export alive until
 * the stream ends. The busy/idle poll on `getStats()` remains the source of
 * truth for stream lifetimes after the initial RPC promise settles.
 */
function wrapStub<T extends object>(
  stub: T,
  domain: string,
  onCallStarted: () => void,
  onCallSettled: () => void,
  getConnectionError: () => unknown,
  getSessionEstablished: () => boolean,
  getSpanAttrs: () => Record<string, string | undefined>
): T {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      // Reflect.apply preserves the method call target because capnweb
      // stubs are Proxies that interpret .apply as an RPC property access.
      return (...args: unknown[]) => {
        onCallStarted();
        const operation =
          typeof prop === 'string' ? `${domain}.${prop}` : domain;
        try {
          const result = Reflect.apply(
            value as (...a: unknown[]) => unknown,
            target,
            args
          );
          // capnweb RpcPromise is a Proxy with typeof 'function',
          // so check for .then directly rather than typeof 'object'.
          if (
            result != null &&
            typeof (result as { then?: unknown }).then === 'function'
          ) {
            // Span the RPC call so each method invocation (and its failure,
            // with error/error.stack attributes) is visible in traces.
            return withSpan(
              `sandbox.rpc.call ${operation}`,
              { ...getSpanAttrs(), operation },
              () =>
                (result as Promise<unknown>).catch((err: unknown) =>
                  translateRPCError(err, {
                    operation,
                    connectionError: getConnectionError(),
                    sessionEstablished: getSessionEstablished()
                  })
                )
            ).finally(onCallSettled);
          }
          onCallSettled();
          return result;
        } catch (err) {
          onCallSettled();
          translateRPCError(err, {
            operation,
            connectionError: getConnectionError(),
            sessionEstablished: getSessionEstablished()
          });
        }
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export interface ContainerControlClientOptions extends ContainerControlConnectionOptions {
  /** Idle timeout before disconnecting the WebSocket (ms). Defaults to 1 000. */
  idleDisconnectMs?: number;
  /** Busy/idle poll interval (ms). Defaults to 1 000. */
  busyPollIntervalMs?: number;
  /**
   * Renew the DO's activity timeout. Fires at the start of every RPC call
   * and on every busy-poll tick while the session has work in flight.
   * Mirrors what `containerFetch()` does at the top of each HTTP request.
   */
  onActivity?: () => void;
  /**
   * Fires once when the capnweb session transitions from idle to busy
   * (an RPC call was started or a stream return is now in flight). The
   * Sandbox DO wires this to `inflightRequests++`, which makes
   * `isActivityExpired()` skip the sleepAfter comparison.
   */
  onSessionBusy?: () => void;
  /**
   * Fires once when the session transitions from busy back to idle
   * (all RPC promises settled and all stream exports released). The
   * Sandbox DO wires this to `inflightRequests = max(0, n-1)` and a
   * final `renewActivityTimeout()`, matching containerFetch's finally
   * block.
   */
  onSessionIdle?: () => void;
}

/**
 * SandboxClient-compatible facade backed by direct capnweb RPC.
 *
 * All operations call the container's SandboxAPI control interface directly
 * over capnweb, bypassing the HTTP handler/router layer entirely.
 *
 * Manages its own WebSocket lifecycle: a fresh `ContainerControlConnection` is
 * created on demand and torn down after `idleDisconnectMs` of inactivity.
 * Busy/idle detection relies on `RpcSession.getStats()` which tracks all
 * in-flight RPC calls and stream exports — including long-lived streaming
 * RPCs that would be invisible to a simple per-call request counter (see
 * the file-level comment for the full rationale).
 */
export class ContainerControlClient {
  private readonly connOptions: ContainerControlConnectionOptions;
  private readonly idleDisconnectMs: number;
  private readonly busyPollIntervalMs: number;
  private readonly logger: Logger;
  private readonly onActivity: (() => void) | undefined;
  private readonly onSessionBusy: (() => void) | undefined;
  private readonly onSessionIdle: (() => void) | undefined;

  private conn: ContainerControlConnection | null = null;
  /**
   * Real cause captured by the connection during startup failure (e.g. a
   * platform container-allocation error). Preferred over the generic capnweb
   * disposal error when translating queued RPC rejections. Cleared each time a
   * fresh connection is created.
   */
  private lastConnectionError: unknown = null;
  /**
   * Whether `lastConnectionError` was captured from an actual connection
   * attempt failure (authoritative root cause) rather than a lifecycle
   * teardown reason (weak). A weak teardown cause — e.g. `onStop` firing
   * `runtime_replaced` — is usually a downstream *consequence* of the real
   * failure, so it must not overwrite an authoritative cause already
   * captured from the connect attempt.
   */
  private connectionErrorIsAuthoritative = false;
  /**
   * Whether the current connection ever established a live session to a
   * running container. Set true by the connection's `onConnected` callback,
   * reset when a fresh connection is created. Lets `translateRPCError`
   * distinguish a true interruption (established, then dropped) from a
   * never-connected failure (container never started).
   */
  private sessionEstablished = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private busyPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Number of RPC method promises that have started but not settled. */
  private activeCalls = 0;
  /** Tracks whether we currently believe the session is busy. */
  private busy = false;

  constructor(options: ContainerControlClientOptions) {
    this.connOptions = {
      stub: options.stub,
      port: options.port,
      localMain: options.localMain,
      logger: options.logger,
      retryTimeoutMs: options.retryTimeoutMs,
      getSandboxInfo: options.getSandboxInfo,
      // Explicit container-start hook: when provided, the connection starts
      // the container in its own retry loop before the WebSocket upgrade so
      // capacity failures throw where we can classify them directly.
      startContainer: options.startContainer,
      // Record that the session actually connected to a running container, so
      // a later teardown is classified as a true OPERATION_INTERRUPTED rather
      // than surfacing as a never-connected failure.
      onConnected: () => {
        this.sessionEstablished = true;
      },
      // Event-driven failure recovery: when the live WebSocket closes
      // or errors, tear the connection down inside the same turn of
      // the event loop so the next RPC call builds a fresh one. The
      // 1Hz busy-poll fallback can't be relied on here — `setInterval`
      // callbacks don't fire while the DO isolate sits idle between
      // requests, which is exactly the state the isolate enters after
      // every in-flight RPC rejects with a peer-closed error.
      onClose: () => {
        if (this.conn) this.destroyConnection();
      },
      // Capture the real startup failure before capnweb masks it on the
      // queued RPC rejections. `translateRPCError` prefers this over the
      // generic disposal / connection-failure transport error.
      onConnectionError: (error: unknown) => {
        // Authoritative: captured from an actual connection-attempt failure.
        this.lastConnectionError = error;
        this.connectionErrorIsAuthoritative = true;
      }
    };
    this.idleDisconnectMs =
      options.idleDisconnectMs ?? DEFAULT_IDLE_DISCONNECT_MS;
    this.busyPollIntervalMs =
      options.busyPollIntervalMs ?? BUSY_POLL_INTERVAL_MS;
    this.logger = options.logger ?? createNoOpLogger();
    this.onActivity = options.onActivity;
    this.onSessionBusy = options.onSessionBusy;
    this.onSessionIdle = options.onSessionIdle;
  }

  // -------------------------------------------------------------------------
  // Connection factory
  // -------------------------------------------------------------------------

  /**
   * Return the current connection, creating one when the client is disconnected.
   * Starts the busy-poll timer the first time a connection is materialized.
   */
  private getConnection(): ContainerControlConnection {
    if (!this.conn) {
      this.lastConnectionError = null;
      this.connectionErrorIsAuthoritative = false;
      this.sessionEstablished = false;
      this.conn = new ContainerControlConnection(this.connOptions);
      this.startBusyPoll();
    }
    return this.conn;
  }

  /**
   * Stamp a *weak* connection cause (a lifecycle teardown reason). Only takes
   * effect if no authoritative connect-attempt failure has been captured, so
   * a teardown consequence never masks the real root cause.
   */
  private stampWeakConnectionCause(cause: unknown): void {
    if (cause === undefined) return;
    if (this.connectionErrorIsAuthoritative) return;
    this.lastConnectionError = cause;
  }

  // -------------------------------------------------------------------------
  // Activity & busy/idle tracking
  // -------------------------------------------------------------------------

  private markBusy(): void {
    if (!this.busy) {
      this.busy = true;
      this.onSessionBusy?.();
    }
    this.clearIdleTimer();
  }

  private isSessionBusy(conn: ContainerControlConnection): boolean {
    const { imports, exports } = conn.getStats();
    return (
      this.activeCalls > 0 ||
      imports > IDLE_IMPORT_THRESHOLD ||
      exports > IDLE_EXPORT_THRESHOLD
    );
  }

  private maybeTransitionIdle(): void {
    const conn = this.conn;
    if (!conn || !conn.isConnected()) return;

    if (this.isSessionBusy(conn)) {
      this.markBusy();
      return;
    }

    if (this.busy) {
      this.busy = false;
      this.onSessionIdle?.();
      this.scheduleIdleDisconnect();
    } else if (!this.idleTimer) {
      this.scheduleIdleDisconnect();
    }
  }

  /**
   * Called synchronously at the start of each RPC method invocation.
   * Renews the DO activity timeout so the sleepAfter alarm is pushed
   * forward before the container processes the call, and pins the RPC
   * WebSocket as busy until the method's promise settles.
   */
  private recordCallStarted = (): void => {
    this.activeCalls++;
    this.markBusy();
    this.onActivity?.();
  };

  private recordCallSettled = (): void => {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
    this.maybeTransitionIdle();
  };

  /** Return the last connection-startup error captured, if any. */
  private getLastConnectionError = (): unknown => this.lastConnectionError;

  /** Whether the current connection ever established a live session. */
  private getSessionEstablished = (): boolean => this.sessionEstablished;

  /**
   * Base span attributes for RPC-call spans: sandbox identifiers plus the
   * container port. Mirrors the connection's `spanAttrs()` so all
   * `sandbox.rpc.*` spans share a consistent shape.
   */
  private getSpanAttrs = (): Record<string, string | undefined> => {
    const info = this.connOptions.getSandboxInfo?.();
    return {
      'sandbox.id': info?.id,
      'sandbox.name': info?.name,
      'sandbox.rpc.port':
        this.connOptions.port !== undefined
          ? String(this.connOptions.port)
          : undefined
    };
  };

  /**
   * Sample `getStats()` and update busy/idle state. While busy, renews the
   * activity timeout each tick so an in-flight stream keeps pushing the
   * sleepAfter deadline forward. On the busy → idle edge, fires
   * `onSessionIdle` and schedules the WebSocket disconnect.
   *
   * If the WebSocket has dropped underneath us (container crash, network
   * blip) we tear the connection down here. `destroyConnection()` fires
   * `onSessionIdle` if we were busy, so the DO's inflight counter doesn't
   * stay pinned forever waiting for a peer that's never going to reply.
   */
  private pollBusyState = (): void => {
    const conn = this.conn;
    if (!conn) return;
    if (!conn.isConnected()) {
      // The WebSocket upgrade is still in progress (or a freshly
      // recreated connection hasn't finished doConnect() yet). Sends
      // are queued in the deferred transport and will flush once the
      // upgrade resolves — don't tear down here.
      //
      // Failure recovery (a peer that disconnected after we connected)
      // is handled synchronously by `ContainerControlConnection`'s
      // `onClose` callback firing `destroyConnection()`, which nulls
      // `this.conn` before the poller could observe it.
      return;
    }

    if (this.isSessionBusy(conn)) {
      this.markBusy();
      // Renew on every busy tick — this is what keeps a long-lived stream
      // alive past sleepAfter.
      this.onActivity?.();
    } else if (this.busy) {
      this.busy = false;
      this.onSessionIdle?.();
      this.scheduleIdleDisconnect();
    } else {
      // Already idle, no state change. Still ensure the disconnect timer
      // is armed (covers the case where we connected but never observed
      // any activity).
      if (!this.idleTimer) this.scheduleIdleDisconnect();
    }
  };

  private startBusyPoll(): void {
    if (this.busyPollTimer) return;
    this.busyPollTimer = setInterval(
      this.pollBusyState,
      this.busyPollIntervalMs
    );
  }

  private stopBusyPoll(): void {
    if (this.busyPollTimer) {
      clearInterval(this.busyPollTimer);
      this.busyPollTimer = null;
    }
  }

  private scheduleIdleDisconnect(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const conn = this.conn;
      if (!conn || !conn.isConnected()) return;

      // Re-check before disconnecting — a new call may have started.
      if (!this.isSessionBusy(conn)) {
        this.logger.debug('Disconnecting idle RPC connection');
        this.destroyConnection();
      }
    }, this.idleDisconnectMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private destroyConnection(cause?: unknown): void {
    this.stopBusyPoll();
    this.clearIdleTimer();
    this.activeCalls = 0;
    // If we tear down while still believing the session is busy, fire the
    // idle transition so the DO's inflight counter doesn't leak.
    if (this.busy) {
      this.busy = false;
      this.onSessionIdle?.();
    }
    if (this.conn) {
      // Weakly stamp the teardown cause so queued RPC calls reject with a
      // real reason instead of the generic capnweb disposal message — but
      // never overwrite an authoritative connect-attempt failure (the
      // teardown is usually a downstream consequence of it). Stamp before
      // disconnect() disposes the stub and rejects the queued calls.
      this.stampWeakConnectionCause(cause);
      this.conn.disconnect(cause);
      this.conn = null;
    }
  }

  // -------------------------------------------------------------------------
  // Sub-client getters
  // -------------------------------------------------------------------------

  // Each getter returns the corresponding nested RpcTarget stub
  // wrapped in a Proxy that translates RPC errors into SandboxError
  // subclasses. Explicit return types keep capnweb's recursive
  // type machinery out of .d.ts output.

  get commands(): SandboxCommandsAPI {
    return wrapStub(
      this.getConnection().rpc().commands,
      'commands',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get files(): SandboxFilesAPI {
    return wrapStub(
      this.getConnection().rpc().files,
      'files',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    ) as unknown as SandboxFilesAPI;
  }
  get processes(): SandboxProcessesAPI {
    return wrapStub(
      this.getConnection().rpc().processes,
      'processes',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get ports(): SandboxPortsAPI {
    return wrapStub(
      this.getConnection().rpc().ports,
      'ports',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get git(): SandboxGitAPI {
    return wrapStub(
      this.getConnection().rpc().git,
      'git',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get utils(): SandboxUtilsAPI {
    return wrapStub(
      this.getConnection().rpc().utils,
      'utils',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get backup(): SandboxBackupAPI {
    return wrapStub(
      this.getConnection().rpc().backup,
      'backup',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get watch(): SandboxWatchAPI {
    return wrapStub(
      this.getConnection().rpc().watch,
      'watch',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get tunnels(): SandboxTunnelsAPI {
    return wrapStub(
      this.getConnection().rpc().tunnels,
      'tunnels',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }
  get interpreter(): SandboxInterpreterAPI {
    return wrapStub(
      this.getConnection().rpc().interpreter,
      'interpreter',
      this.recordCallStarted,
      this.recordCallSettled,
      this.getLastConnectionError,
      this.getSessionEstablished,
      this.getSpanAttrs
    );
  }

  /**
   * Update the upgrade retry budget. Applies to the current connection
   * (if any) and is remembered for any future connections created after the
   * client is torn down and reconnected.
   */
  setRetryTimeoutMs(ms: number): void {
    this.connOptions.retryTimeoutMs = ms;
    this.conn?.setRetryTimeoutMs(ms);
  }

  getTransportMode(): SandboxTransport {
    return 'rpc';
  }

  isWebSocketConnected(): boolean {
    return this.conn?.isConnected() ?? false;
  }

  async connect(): Promise<void> {
    await this.getConnection().connect();
  }

  /**
   * Tear down the active connection.
   *
   * When a connection attempt is still in progress, the teardown is deferred
   * until that attempt settles — so a lifecycle disconnect (e.g. the DO's
   * alarm firing `onStop`) cannot rip the transport out from under an
   * in-flight connect and reject queued calls with a generic disposal error.
   * The provided `cause` is stamped immediately so that if the attempt fails,
   * queued calls surface it; if the attempt succeeds, the (now-established)
   * connection is then torn down cleanly with the cause.
   *
   * `cause` should be a typed `SandboxError` describing why the connection is
   * being torn down (sandbox stopping, lifetime change, transport switch).
   */
  disconnect(cause?: unknown): void {
    const conn = this.conn;
    if (conn?.isConnecting()) {
      // Weakly stamp the cause so an in-flight-attempt failure (authoritative)
      // still wins over this teardown reason.
      this.stampWeakConnectionCause(cause);
      // Defer the actual teardown until the attempt settles. Guard with an
      // identity check so we don't destroy a newer connection.
      void conn.whenSettled().then(() => {
        if (this.conn === conn) this.destroyConnection(cause);
      });
      return;
    }
    this.destroyConnection(cause);
  }
}

/**
 * Extracts the public key set of a type. Used to verify that
 * ContainerControlClient exposes the same top-level properties and methods
 * as SandboxClient with top-level key coverage. Sub-clients are capnweb stubs, not HTTP
 * client class instances.
 */
type PublicKeys<T> = { [K in keyof T]: unknown };

// Compile-time check: ContainerControlClient has every public key that SandboxClient has.
void (0 as unknown as PublicKeys<ContainerControlClient> satisfies PublicKeys<SandboxClient>);
