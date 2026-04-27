/**
 * SandboxClient implementation backed by direct capnweb RPC calls.
 *
 * The server exposes each domain (commands, files, processes, etc.) as a
 * nested RpcTarget. capnweb returns typed stubs for these so the client
 * can use `rpc.commands`, `rpc.files`, etc. directly without any
 * per-method boilerplate.
 *
 * Manages its own connection lifecycle: creates a fresh ContainerConnection
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
  SandboxDesktopAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxInterpreterAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import {
  type ErrorCode,
  type ErrorResponse,
  getHttpStatus
} from '@repo/shared/errors';
import {
  ContainerConnection,
  type ContainerConnectionOptions
} from '../container-connection';
import { createErrorFromResponse } from '../errors/adapter';
import type { SandboxClient } from './sandbox-client';
import type { TransportMode } from './transport';

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

interface RPCErrorPayload {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Translate a capnweb-propagated error into a typed SandboxError.
 *
 * capnweb only preserves `error.name` and `error.message` across the wire.
 * The container encodes the full error as a JSON object in the message
 * string: `{"code":"...","message":"...","context":{...}}`.
 */
function translateRPCError(error: unknown): never {
  if (error instanceof Error) {
    try {
      const payload = JSON.parse(error.message) as RPCErrorPayload;
      if (
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
    } catch (e) {
      if (e instanceof Error && e !== error) throw e;
    }
  }
  throw error;
}

/**
 * Wrap a capnweb RPC stub so that every method call translates errors
 * from the JSON wire format into typed SandboxError instances and signals
 * activity at call start.
 *
 * `onCallStarted` fires synchronously when an RPC method is invoked. The
 * RPCSandboxClient uses this to renew the DO's activity timeout
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
      // Use Reflect.apply instead of value.apply() because capnweb
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

export interface RPCSandboxClientOptions extends ContainerConnectionOptions {
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
 * SandboxClient backed by direct capnweb RPC.
 *
 * Drop-in replacement for SandboxClient when the capnweb transport is active.
 * All operations call the container's SandboxRPCAPI directly over capnweb,
 * bypassing the HTTP handler/router layer entirely.
 *
 * Manages its own WebSocket lifecycle: a fresh `ContainerConnection` is
 * created on demand and torn down after `idleDisconnectMs` of inactivity.
 * Busy/idle detection relies on `RpcSession.getStats()` which tracks all
 * in-flight RPC calls and stream exports — including long-lived streaming
 * RPCs that would be invisible to a simple per-call request counter (see
 * the file-level comment for the full rationale).
 */
export class RPCSandboxClient {
  private readonly connOptions: ContainerConnectionOptions;
  private readonly idleDisconnectMs: number;
  private readonly busyPollIntervalMs: number;
  private readonly logger: Logger;
  private readonly onActivity: (() => void) | undefined;
  private readonly onSessionBusy: (() => void) | undefined;
  private readonly onSessionIdle: (() => void) | undefined;

  private conn: ContainerConnection | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private busyPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether we currently believe the session is busy. */
  private busy = false;
  /**
   * Set the first time the poller observes `conn.isConnected() === true`,
   * cleared in `destroyConnection()`. Lets us distinguish "the WebSocket
   * upgrade is still in progress" (don't tear down) from "we were
   * connected and the peer went away" (do tear down).
   */
  private wasEverConnected = false;

  constructor(options: RPCSandboxClientOptions) {
    this.connOptions = {
      stub: options.stub,
      port: options.port,
      logger: options.logger
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
   * Return the current connection, creating a new one if none exists or the
   * previous one was torn down by an idle disconnect. Starts the busy-poll
   * timer the first time a connection is materialized.
   */
  private getConnection(): ContainerConnection {
    if (!this.conn) {
      this.conn = new ContainerConnection(this.connOptions);
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
      // Two distinct cases share the same `isConnected() === false`
      // signal:
      //   1. The WebSocket upgrade is still in progress — we constructed
      //      the connection in getConnection() but doConnect() hasn't
      //      resolved yet. Sends are queued in the deferred transport.
      //      Tearing down here would drop those queued calls on the floor.
      //   2. We were connected and the peer went away (container crash,
      //      network blip). The session is dead, we must release
      //      inflight and stop polling.
      // `wasEverConnected` distinguishes them: it flips to true the first
      // time we observe a live connection below.
      if (this.wasEverConnected) {
        this.destroyConnection();
      }
      return;
    }
    this.wasEverConnected = true;

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
        this.logger.debug('Disconnecting idle capnweb connection');
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
    this.wasEverConnected = false;
  }

  // -------------------------------------------------------------------------
  // Sub-client getters
  // -------------------------------------------------------------------------

  // Each getter returns the corresponding nested RpcTarget stub
  // wrapped in a Proxy that translates RPC errors into SandboxError
  // subclasses. Explicit return types prevent capnweb's recursive
  // type machinery from expanding in .d.ts output (causes OOM).

  get commands(): SandboxCommandsAPI {
    return wrapStub(this.getConnection().rpc().commands, this.renewActivity);
  }
  get files(): SandboxFilesAPI {
    return wrapStub(this.getConnection().rpc().files, this.renewActivity);
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
  get desktop(): SandboxDesktopAPI {
    return wrapStub(this.getConnection().rpc().desktop, this.renewActivity);
  }
  get watch(): SandboxWatchAPI {
    return wrapStub(this.getConnection().rpc().watch, this.renewActivity);
  }
  get interpreter(): SandboxInterpreterAPI {
    return wrapStub(this.getConnection().rpc().interpreter, this.renewActivity);
  }

  setRetryTimeoutMs(_ms: number): void {
    // RPC transport does not use HTTP retry budgets
  }

  getTransportMode(): TransportMode {
    return 'rpc';
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

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    sessionId: string
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }> {
    return this.files.writeFileStream(path, stream, sessionId);
  }
}

/**
 * Extracts the public key set of a type. Used to verify that
 * RPCSandboxClient exposes the same top-level properties and methods
 * as SandboxClient without requiring deep structural compatibility
 * (sub-clients are capnweb stubs, not HTTP client class instances).
 */
type PublicKeys<T> = { [K in keyof T]: unknown };

// Compile-time check: RPCSandboxClient has every public key that SandboxClient has.
void (0 as unknown as PublicKeys<RPCSandboxClient> satisfies PublicKeys<SandboxClient>);
