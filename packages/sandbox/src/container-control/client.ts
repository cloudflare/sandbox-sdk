/**
 * Sandbox control client implementation backed by direct capnweb RPC calls.
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
  SandboxTunnelsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import {
  ErrorCode,
  type ErrorResponse,
  getHttpStatus,
  getSuggestion,
  type RPCTransportContext,
  type RPCTransportErrorKind
} from '@repo/shared/errors';
import { createErrorFromResponse } from '../errors/adapter';
import {
  ContainerControlConnection,
  type ContainerControlConnectionOptions
} from './connection';

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
export function translateRPCError(error: unknown): never {
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
    // Map capnweb / DeferredTransport messages onto a typed RPCTransportError
    // so consumers get structured `code` and `kind` fields.
    // Preserve the underlying capnweb/transport Error as `cause` so callers
    // can reach the original via `err.cause` (and it shows up in toString /
    // toJSON output) without having to substring-match the message.
    throw createErrorFromResponse(
      buildTransportErrorResponse(error) as unknown as ErrorResponse,
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
 * Wrap a capnweb RPC stub so that every method call translates errors
 * from the JSON wire format into typed SandboxError instances and signals
 * activity at call start.
 *
 * `onCallStarted` fires synchronously when an RPC method is invoked. The
 * ContainerControlClient uses this to renew the DO's activity timeout
 * immediately, so even a call that completes entirely between two
 * busy-poll ticks still pushes the sleepAfter deadline forward.
 *
 * Note: there is no `onCallSettled` hook. A method whose returned promise
 * resolves with a `ReadableStream` is *not* finished when the promise
 * settles — capnweb keeps the export alive until the stream ends. The
 * busy/idle poll on `getStats()` is the source of truth for that.
 */
function wrapStub<T extends object>(stub: T, onCallStarted: () => void): T {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      // Reflect.apply preserves the method call target because capnweb
      // stubs are Proxies that interpret .apply as an RPC property access.
      return (...args: unknown[]) => {
        onCallStarted();
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
            return (result as Promise<unknown>).catch(translateRPCError);
          }
          return result;
        } catch (err) {
          translateRPCError(err);
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
   * Sandbox DO wires this to increment the Container base class's
   * in-flight request counter, which makes `isActivityExpired()` skip the
   * sleepAfter comparison.
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
 * Sandbox control facade backed by direct capnweb RPC.
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
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private busyPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether we currently believe the session is busy. */
  private busy = false;

  constructor(options: ContainerControlClientOptions) {
    this.connOptions = {
      stub: options.stub,
      port: options.port,
      localMain: options.localMain,
      logger: options.logger,
      retryTimeoutMs: options.retryTimeoutMs,
      // Event-driven failure recovery: when the live WebSocket closes
      // or errors, tear the connection down inside the same turn of
      // the event loop so the next RPC call builds a fresh one. The
      // 1Hz busy-poll fallback can't be relied on here — `setInterval`
      // callbacks don't fire while the DO isolate sits idle between
      // requests, which is exactly the state the isolate enters after
      // every in-flight RPC rejects with a peer-closed error.
      onClose: () => {
        if (this.conn) this.destroyConnection();
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
      this.conn = new ContainerControlConnection(this.connOptions);
      this.startBusyPoll();
    }
    return this.conn;
  }

  // -------------------------------------------------------------------------
  // Activity & busy/idle tracking
  // -------------------------------------------------------------------------

  /**
   * Called synchronously at the start of each RPC method invocation.
   * Renews the DO activity timeout so the sleepAfter alarm is pushed
   * forward before the container processes the call.
   */
  private renewActivity = (): void => {
    this.onActivity?.();
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

    const { imports, exports } = conn.getStats();
    const isBusy =
      imports > IDLE_IMPORT_THRESHOLD || exports > IDLE_EXPORT_THRESHOLD;

    if (isBusy) {
      if (!this.busy) {
        this.busy = true;
        this.onSessionBusy?.();
      }
      // Renew on every busy tick — this is what keeps a long-lived stream
      // alive past sleepAfter.
      this.onActivity?.();
      this.clearIdleTimer();
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
      const { imports, exports } = conn.getStats();
      if (
        imports <= IDLE_IMPORT_THRESHOLD &&
        exports <= IDLE_EXPORT_THRESHOLD
      ) {
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

  private destroyConnection(): void {
    this.stopBusyPoll();
    this.clearIdleTimer();
    // If we tear down while still believing the session is busy, fire the
    // idle transition so the DO's inflight counter doesn't leak.
    if (this.busy) {
      this.busy = false;
      this.onSessionIdle?.();
    }
    if (this.conn) {
      this.conn.disconnect();
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
    return wrapStub(this.getConnection().rpc().commands, this.renewActivity);
  }
  get files(): SandboxFilesAPI {
    return wrapStub(
      this.getConnection().rpc().files,
      this.renewActivity
    ) as unknown as SandboxFilesAPI;
  }
  get processes(): SandboxProcessesAPI {
    return wrapStub(this.getConnection().rpc().processes, this.renewActivity);
  }
  get ports(): SandboxPortsAPI {
    return wrapStub(this.getConnection().rpc().ports, this.renewActivity);
  }
  get git(): SandboxGitAPI {
    return wrapStub(this.getConnection().rpc().git, this.renewActivity);
  }
  get utils(): SandboxUtilsAPI {
    return wrapStub(this.getConnection().rpc().utils, this.renewActivity);
  }
  get backup(): SandboxBackupAPI {
    return wrapStub(this.getConnection().rpc().backup, this.renewActivity);
  }
  get watch(): SandboxWatchAPI {
    return wrapStub(this.getConnection().rpc().watch, this.renewActivity);
  }
  get tunnels(): SandboxTunnelsAPI {
    return wrapStub(this.getConnection().rpc().tunnels, this.renewActivity);
  }
  get interpreter(): SandboxInterpreterAPI {
    return wrapStub(this.getConnection().rpc().interpreter, this.renewActivity);
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

  isWebSocketConnected(): boolean {
    return this.conn?.isConnected() ?? false;
  }

  async connect(): Promise<void> {
    await this.getConnection().connect();
  }

  disconnect(): void {
    this.destroyConnection();
  }
}
