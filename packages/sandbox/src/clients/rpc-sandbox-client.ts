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
 * from the `[CODE] message` wire format into typed SandboxError instances.
 *
 * `onCallStarted` fires synchronously when an RPC method is invoked.
 * `onCallSettled` fires after each promise-returning call resolves or
 * rejects. The RPCSandboxClient uses these to renew the DO activity
 * timeout (start) and check for idle disconnect (settle).
 */
function wrapStub<T extends object>(
  stub: T,
  onCallStarted?: () => void,
  onCallSettled?: () => void
): T {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      // Return a wrapper that catches errors from the RPC call.
      // Use Reflect.apply instead of value.apply() because capnweb
      // stubs are Proxies that interpret .apply as an RPC property access.
      return (...args: unknown[]) => {
        onCallStarted?.();
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
            return (result as Promise<unknown>)
              .catch(translateRPCError)
              .finally(() => onCallSettled?.());
          }
          // Non-promise return: settle immediately so the inflight
          // counter doesn't drift.
          onCallSettled?.();
          return result;
        } catch (err) {
          // Synchronous throw: settle before re-throwing so the
          // inflight counter doesn't drift.
          onCallSettled?.();
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
  /**
   * Fires at the start of each RPC call. The Sandbox DO wires this to
   * increment inflightRequests and renew the activity timeout, matching
   * what containerFetch() does for the HTTP transport.
   */
  onActivity?: () => void;
  /**
   * Fires after each RPC call settles. The Sandbox DO wires this to
   * decrement inflightRequests and renew the activity timeout when the
   * count reaches zero, matching containerFetch's finally block.
   */
  onIdle?: () => void;
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
 * Idle detection relies on `RpcSession.getStats()` which tracks all in-flight
 * RPC calls and streams — including long-lived streaming RPCs that would be
 * invisible to a simple request counter.
 */
export class RPCSandboxClient {
  private readonly connOptions: ContainerConnectionOptions;
  private readonly idleDisconnectMs: number;
  private readonly logger: Logger;
  private readonly onActivity: (() => void) | undefined;
  private readonly onIdle: (() => void) | undefined;

  private conn: ContainerConnection | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RPCSandboxClientOptions) {
    this.connOptions = {
      stub: options.stub,
      port: options.port,
      logger: options.logger
    };
    this.idleDisconnectMs =
      options.idleDisconnectMs ?? DEFAULT_IDLE_DISCONNECT_MS;
    this.logger = options.logger ?? createNoOpLogger();
    this.onActivity = options.onActivity;
    this.onIdle = options.onIdle;
  }

  // -------------------------------------------------------------------------
  // Connection factory
  // -------------------------------------------------------------------------

  /**
   * Return the current connection, creating a new one if none exists or the
   * previous one was torn down by an idle disconnect.
   */
  private getConnection(): ContainerConnection {
    if (!this.conn) {
      this.conn = new ContainerConnection(this.connOptions);
    }
    return this.conn;
  }

  // -------------------------------------------------------------------------
  // Idle disconnect
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
   * Called after each RPC promise settles. Decrements the DO's inflight
   * counter via onIdle, then checks whether the capnweb session is idle
   * enough to disconnect the WebSocket.
   */
  private checkIdle = (): void => {
    this.onIdle?.();
    const conn = this.conn;
    if (!conn || !conn.isConnected()) return;

    const { imports, exports } = conn.getStats();
    if (imports <= IDLE_IMPORT_THRESHOLD && exports <= IDLE_EXPORT_THRESHOLD) {
      this.scheduleIdleDisconnect();
    } else {
      // Still busy — clear any pending timer and wait for the next settle.
      this.clearIdleTimer();
    }
  };

  private scheduleIdleDisconnect(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Re-check before disconnecting — a new call may have started.
      const conn = this.conn;
      if (!conn || !conn.isConnected()) return;

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
  // subclasses. Explicit return types prevent capnweb's recursive
  // type machinery from expanding in .d.ts output (causes OOM).

  get commands(): SandboxCommandsAPI {
    return wrapStub(
      this.getConnection().rpc().commands,
      this.renewActivity,
      this.checkIdle
    );
  }
  get files(): SandboxFilesAPI {
    return wrapStub(
      this.getConnection().rpc().files,
      this.renewActivity,
      this.checkIdle
    );
  }
  get processes(): SandboxProcessesAPI {
    return wrapStub(
      this.getConnection().rpc().processes,
      this.renewActivity,
      this.checkIdle
    );
  }
  get ports(): SandboxPortsAPI {
    return wrapStub(
      this.getConnection().rpc().ports,
      this.renewActivity,
      this.checkIdle
    );
  }
  get git(): SandboxGitAPI {
    return wrapStub(
      this.getConnection().rpc().git,
      this.renewActivity,
      this.checkIdle
    );
  }
  get utils(): SandboxUtilsAPI {
    return wrapStub(
      this.getConnection().rpc().utils,
      this.renewActivity,
      this.checkIdle
    );
  }
  get backup(): SandboxBackupAPI {
    return wrapStub(
      this.getConnection().rpc().backup,
      this.renewActivity,
      this.checkIdle
    );
  }
  get desktop(): SandboxDesktopAPI {
    return wrapStub(
      this.getConnection().rpc().desktop,
      this.renewActivity,
      this.checkIdle
    );
  }
  get watch(): SandboxWatchAPI {
    return wrapStub(
      this.getConnection().rpc().watch,
      this.renewActivity,
      this.checkIdle
    );
  }
  get interpreter(): SandboxInterpreterAPI {
    return wrapStub(
      this.getConnection().rpc().interpreter,
      this.renewActivity,
      this.checkIdle
    );
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
    this.clearIdleTimer();
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
