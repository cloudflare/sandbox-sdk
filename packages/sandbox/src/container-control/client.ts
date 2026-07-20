/** Sandbox control client implementation backed by direct capnweb RPC calls. */

import type {
  Logger,
  SandboxBackupAPI,
  SandboxExtensionsAPI,
  SandboxFilesAPI,
  SandboxMountsAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxTerminalsAPI,
  SandboxTunnelsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI,
  SandboxWorkspaceAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import {
  ContainerControlConnection,
  type ContainerControlConnectionOptions
} from './connection';
import { createControlDomainProxy } from './rpc-proxy';

export { translateRPCError } from './rpc-error';

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
  /** Verifies that the owning runtime lease still permits RPC dispatch. */
  onDispatch?: () => void;
  /** Fires when the underlying connection closes or fails. */
  onConnectionClose?: () => void;
  /** Maps transport loss to operation interruption for the waking facade. */
  translateTransportErrorsAsInterruptions?: boolean;
  connection?: ContainerControlConnection;
  externallyOwnedConnection?: boolean;
  /**
   * Fires once when the capnweb session transitions from idle to busy
   * (an RPC call was started or a stream return is now in flight). The
   * Sandbox DO wires this to the resource activity gate so current
   * session ownership blocks an inactivity stop.
   */
  onSessionBusy?: () => void;
  /**
   * Fires once when the session transitions from busy back to idle
   * (all RPC promises settled and all stream exports released). The
   * Sandbox DO releases the gate operation for the current control
   * session and renews activity for the idle transition.
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
  private readonly connOptions: ContainerControlConnectionOptions & {
    connection?: ContainerControlConnection;
    externallyOwnedConnection?: boolean;
  };
  private readonly idleDisconnectMs: number;
  private readonly busyPollIntervalMs: number;
  private readonly logger: Logger;
  private readonly onActivity: (() => void) | undefined;
  private readonly onDispatch: (() => void) | undefined;
  private readonly onConnectionClose: (() => void) | undefined;
  private readonly translateTransportErrorsAsInterruptions: boolean;
  private readonly onSessionBusy: (() => void) | undefined;
  private readonly onSessionIdle: (() => void) | undefined;

  private conn: ContainerControlConnection | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private busyPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether we currently believe the session is busy. */
  private busy = false;
  private connectionRetainers = 0;
  private connectionGeneration = 0;

  constructor(options: ContainerControlClientOptions) {
    this.connOptions = {
      stub: options.stub,
      port: options.port,
      localMain: options.localMain,
      logger: options.logger,
      connection: options.connection,
      externallyOwnedConnection: options.externallyOwnedConnection,
      // Event-driven failure recovery: when the live WebSocket closes
      // or errors, tear the connection down inside the same turn of
      // the event loop so the next RPC call builds a fresh one. The
      // 1Hz busy-poll fallback can't be relied on here — `setInterval`
      // callbacks don't fire while the DO isolate sits idle between
      // requests, which is exactly the state the isolate enters after
      // every in-flight RPC rejects with a peer-closed error.
      onClose: () => {
        if (this.conn) this.destroyConnection();
        this.onConnectionClose?.();
      }
    };
    this.idleDisconnectMs =
      options.idleDisconnectMs ?? DEFAULT_IDLE_DISCONNECT_MS;
    this.busyPollIntervalMs =
      options.busyPollIntervalMs ?? BUSY_POLL_INTERVAL_MS;
    this.logger = options.logger ?? createNoOpLogger();
    this.onActivity = options.onActivity;
    this.onDispatch = options.onDispatch;
    this.onConnectionClose = options.onConnectionClose;
    this.translateTransportErrorsAsInterruptions =
      options.translateTransportErrorsAsInterruptions ?? true;
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
    this.onDispatch?.();
    if (!this.conn) {
      this.conn =
        this.connOptions.connection ??
        new ContainerControlConnection(this.connOptions);
      if (!this.connOptions.externallyOwnedConnection) this.startBusyPoll();
    }
    return this.conn;
  }

  // -------------------------------------------------------------------------
  // Activity & busy/idle tracking
  // -------------------------------------------------------------------------

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
      this.connectionRetainers > 0 ||
      imports > IDLE_IMPORT_THRESHOLD ||
      exports > IDLE_EXPORT_THRESHOLD;

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
        this.connectionRetainers === 0 &&
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
    this.connectionRetainers = 0;
    this.connectionGeneration += 1;
    // If we tear down while still believing the session is busy, fire the
    // idle transition so the DO's inflight counter doesn't leak.
    if (this.busy) {
      this.busy = false;
      this.onSessionIdle?.();
    }
    if (this.conn) {
      if (!this.connOptions.externallyOwnedConnection) {
        this.conn.disconnect();
      }
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

  private createDomainProxy<T extends object>(
    getStub: () => T,
    domain: string
  ): T {
    return createControlDomainProxy(
      getStub,
      domain,
      this.translateTransportErrorsAsInterruptions
    );
  }

  get files(): SandboxFilesAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().files,
      'files'
    ) as unknown as SandboxFilesAPI;
  }
  get ports(): SandboxPortsAPI {
    // capnweb's recursive stream stub type cannot express the shared stream
    // subscription contract at this external RPC boundary.
    return this.createDomainProxy(
      () => this.getConnection().rpc().ports,
      'ports'
    ) as unknown as SandboxPortsAPI;
  }
  get processes(): SandboxProcessesAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().processes,
      'processes'
    ) as unknown as SandboxProcessesAPI;
  }
  get mounts(): SandboxMountsAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().mounts,
      'mounts'
    ) as unknown as SandboxMountsAPI;
  }
  get workspace(): SandboxWorkspaceAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().workspace,
      'workspace'
    ) as unknown as SandboxWorkspaceAPI;
  }
  get utils(): SandboxUtilsAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().utils,
      'utils'
    );
  }
  get backup(): SandboxBackupAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().backup,
      'backup'
    );
  }
  get watch(): SandboxWatchAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().watch,
      'watch'
    );
  }
  get tunnels(): SandboxTunnelsAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().tunnels,
      'tunnels'
    );
  }
  get terminals(): SandboxTerminalsAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().terminals,
      'terminals'
    ) as unknown as SandboxTerminalsAPI;
  }
  get extensions(): SandboxExtensionsAPI {
    return this.createDomainProxy(
      () => this.getConnection().rpc().extensions,
      'extensions'
    );
  }

  isWebSocketConnected(): boolean {
    return this.conn?.isConnected() ?? false;
  }

  async connect(): Promise<void> {
    await this.getConnection().connect();
  }

  retainRuntimeHold(): () => void {
    this.getConnection();
    const generation = this.connectionGeneration;
    this.connectionRetainers += 1;
    this.clearIdleTimer();
    let released = false;

    return () => {
      if (released || generation !== this.connectionGeneration) return;
      released = true;
      this.connectionRetainers -= 1;
      if (this.connectionRetainers === 0 && !this.busy) {
        this.scheduleIdleDisconnect();
      }
    };
  }

  disconnect(): void {
    this.destroyConnection();
  }
}
