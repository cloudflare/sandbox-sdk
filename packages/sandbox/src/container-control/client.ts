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
 *     `ReadableStream` from an RPC method (e.g. `processes.streamProcessLogs`),
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
 * `processes.streamProcessLogs(...)` resolves in milliseconds with a stream
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
  SandboxExtensionsAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxTerminalsAPI,
  SandboxTunnelsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import {
  createNoOpLogger,
  SANDBOX_CONTROL_PROTOCOL_VERSION
} from '@repo/shared';
import { SandboxError } from '../errors/classes';
import { SDK_VERSION } from '../version';
import {
  ContainerControlConnection,
  type ContainerControlConnectionOptions
} from './connection';
import { throwVersionMismatch } from './errors';
import { createRPCDomain } from './rpc-domain';

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
  private compatibleConnection: ContainerControlConnection | null = null;
  private compatibilityCheck: Promise<void> | null = null;

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
    this.compatibleConnection = null;
    this.compatibilityCheck = null;
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

  private async verifyRuntimeCompatibility(
    conn: ContainerControlConnection
  ): Promise<void> {
    let runtimeInfo: {
      protocolVersion: number;
      containerVersion?: string;
    };
    try {
      const runtime = conn.rpc().runtime;
      if (runtime == null || typeof runtime.getRuntimeInfo !== 'function') {
        throwVersionMismatch({
          reason: 'missing_handshake',
          sdkVersion: SDK_VERSION,
          supportedProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION
        });
      }
      runtimeInfo = await runtime.getRuntimeInfo();
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      throwVersionMismatch(
        {
          reason: 'missing_handshake',
          sdkVersion: SDK_VERSION,
          supportedProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION
        },
        err
      );
    }

    if (runtimeInfo.protocolVersion !== SANDBOX_CONTROL_PROTOCOL_VERSION) {
      throwVersionMismatch({
        reason: 'unsupported_protocol',
        sdkVersion: SDK_VERSION,
        containerVersion: runtimeInfo.containerVersion,
        supportedProtocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
        containerProtocolVersion: runtimeInfo.protocolVersion
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sub-client getters
  // -------------------------------------------------------------------------

  // Each getter returns a lazy domain facade. The connection is materialized
  // immediately so lifecycle hooks stay tied to getter access, while the
  // actual RPC domain/method lookup happens after connect() verifies the
  // currently active runtime protocol.
  private domain<T extends object>(
    name: string,
    getStub: (conn: ContainerControlConnection) => T
  ): T {
    this.getConnection();
    return createRPCDomain(
      () => getStub(this.getConnection()),
      name,
      () => this.connect(),
      this.renewActivity
    );
  }

  get commands(): SandboxCommandsAPI {
    return this.domain('commands', (conn) => conn.rpc().commands);
  }
  get files(): SandboxFilesAPI {
    return this.domain(
      'files',
      (conn) => conn.rpc().files
    ) as unknown as SandboxFilesAPI;
  }
  get processes(): SandboxProcessesAPI {
    return this.domain('processes', (conn) => conn.rpc().processes);
  }
  get ports(): SandboxPortsAPI {
    return this.domain('ports', (conn) => conn.rpc().ports);
  }
  get git(): SandboxGitAPI {
    return this.domain('git', (conn) => conn.rpc().git);
  }
  get utils(): SandboxUtilsAPI {
    return this.domain('utils', (conn) => conn.rpc().utils);
  }
  get backup(): SandboxBackupAPI {
    return this.domain('backup', (conn) => conn.rpc().backup);
  }
  get watch(): SandboxWatchAPI {
    return this.domain('watch', (conn) => conn.rpc().watch);
  }
  get tunnels(): SandboxTunnelsAPI {
    return this.domain('tunnels', (conn) => conn.rpc().tunnels);
  }
  get terminals(): SandboxTerminalsAPI {
    return this.domain('terminals', (conn) => conn.rpc().terminals);
  }
  get extensions(): SandboxExtensionsAPI {
    return this.domain('extensions', (conn) => conn.rpc().extensions);
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
    const conn = this.getConnection();
    if (this.compatibleConnection === conn) return;
    if (this.compatibilityCheck) return this.compatibilityCheck;

    const check = this.connectAndVerify(conn);
    this.compatibilityCheck = check;
    try {
      await check;
    } finally {
      if (this.compatibilityCheck === check) {
        this.compatibilityCheck = null;
      }
    }
  }

  private async connectAndVerify(
    conn: ContainerControlConnection
  ): Promise<void> {
    await conn.connect();
    await this.verifyRuntimeCompatibility(conn);
    if (this.conn === conn) {
      this.compatibleConnection = conn;
    }
  }

  disconnect(): void {
    this.destroyConnection();
  }
}
