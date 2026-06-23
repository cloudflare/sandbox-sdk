/**
 * Capnweb RPC connection to the container.
 *
 * Manages a single WebSocket session and exposes typed methods that map
 * 1:1 to the container's SandboxAPI. The Sandbox DO calls these directly,
 * bypassing the route-based HTTP client layer.
 */

import type {
  Logger,
  SandboxAPI,
  SandboxBackupAPI,
  SandboxCommandsAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxInterpreterAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { ErrorCode, getHttpStatus, getSuggestion } from '@repo/shared/errors';
import { RpcSession, type RpcStub, type RpcTransport } from 'capnweb';
import { createErrorFromResponse } from '../errors/adapter';
import {
  fetchWithResponseRetry,
  isRetryableWebSocketUpgradeResponse
} from '../response-retry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wire shape used by the container and by SDK-internal throws. */
interface StructuredErrorBody {
  code?: string;
  message?: string;
  context?: Record<string, unknown>;
}

/**
 * Attempt to parse a structured CONTAINER_UNAVAILABLE JSON body from a
 * non-101 upgrade response. Returns a typed ContainerUnavailableError when
 * the body contains a recognized code, or null if the response is not
 * JSON / not a container availability error.
 *
 * The response body is consumed only once via `clone()` so the caller still
 * holds the original Response.
 */
async function tryParseContainerUnavailable(
  response: Response
): Promise<Error | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;

  try {
    const body = (await response.clone().json()) as StructuredErrorBody;
    if (body.code !== ErrorCode.CONTAINER_UNAVAILABLE) return null;

    const reason =
      body.context?.reason === 'container_starting' ||
      body.context?.reason === 'container_unhealthy' ||
      body.context?.reason === 'container_replaced' ||
      body.context?.reason === 'rpc_upgrade_failed'
        ? body.context.reason
        : 'container_replaced';
    const context = {
      reason,
      retryable: true as const,
      ...(typeof body.context?.retryAfterMs === 'number' && {
        retryAfterMs: body.context.retryAfterMs
      })
    };

    return createErrorFromResponse({
      code: ErrorCode.CONTAINER_UNAVAILABLE,
      message: body.message ?? 'Container is unavailable',
      context,
      httpStatus: getHttpStatus(ErrorCode.CONTAINER_UNAVAILABLE),
      suggestion: getSuggestion(ErrorCode.CONTAINER_UNAVAILABLE, context),
      timestamp: new Date().toISOString()
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_TIMEOUT_MS = 120_000; // 2 minute total budget for upgrade retries
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to attempt a retry

/** Stub that can issue a WebSocket-upgrade fetch through the DO's Container base class. */
export interface ContainerFetchStub {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerControlConnectionOptions {
  stub: ContainerFetchStub;
  port?: number;
  logger?: Logger;
  /**
   * Total retry budget (ms) for retryable upgrade responses while the
   * container is unavailable. Defaults to 120 000 (2 minutes), matching the
   * route-based `WebSocketTransport`. Set to 0 to disable retries.
   */
  retryTimeoutMs?: number;
  /**
   * Optional `localMain` exposed to the container side of the capnweb
   * session. The container reaches it via
   * `session.getRemoteMain()` and uses it for control-plane callbacks
   * (e.g. notifying the DO when a tunnel's cloudflared process has
   * exited). When omitted, the container sees an empty remote main.
   */
  localMain?: any;
  /**
   * Invoked when connection setup fails or an active WebSocket transitions
   * to closed/errored. Fired at most once per connection attempt. Gives
   * owners a synchronous teardown signal so recovery doesn't depend on a
   * periodic poller running inside what may be an idle isolate.
   *
   * Not fired for `disconnect()`.
   */
  onClose?: () => void;
}

/**
 * Manages a capnweb WebSocket RPC session to the container.
 *
 * The RPC stub is created eagerly in the constructor using a deferred
 * transport. Calls made before `connect()` completes are queued in the
 * transport and flushed once the WebSocket is established.
 */
export class ContainerControlConnection {
  private readonly stub: RpcStub<SandboxAPI>;
  private readonly session: RpcSession<SandboxAPI>;
  private readonly transport: DeferredTransport;
  private ws: WebSocket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private readonly containerStub: ContainerFetchStub;
  private readonly port: number;
  private readonly logger: Logger;
  private retryTimeoutMs: number;
  private readonly onClose: (() => void) | undefined;

  constructor(options: ContainerControlConnectionOptions) {
    this.containerStub = options.stub;
    this.port = options.port ?? 3000;
    this.logger = options.logger ?? createNoOpLogger();
    this.retryTimeoutMs = options.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
    this.onClose = options.onClose;

    this.transport = new DeferredTransport();
    this.session = new RpcSession<SandboxAPI>(
      this.transport,
      options.localMain
    );
    this.stub = this.session.getRemoteMain();
  }

  /**
   * Get the typed RPC stub.
   *
   * The stub is available immediately — calls made before connect()
   * completes are queued in the deferred transport and flushed once
   * the WebSocket is established.
   */
  rpc(): RpcStub<SandboxAPI> {
    if (!this.connected && !this.connectPromise) {
      this.connect().catch(() => {});
    }
    return this.stub;
  }

  /**
   * Return capnweb session statistics. The `imports` and `exports` counts
   * reflect all in-flight RPC calls, streams, and peer-held references.
   * An idle session has imports <= 1 && exports <= 1 (the bootstrap stubs).
   */
  getStats(): { imports: number; exports: number } {
    return this.session.getStats();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  disconnect(): void {
    try {
      (this.stub as unknown as Disposable)[Symbol.dispose]?.();
    } catch {
      // Stub may already be disposed
    }
    if (this.ws) {
      // Unbind first so a late `close` / `error` event dispatched by
      // the runtime after we've decided this connection is dead can't
      // reach a successor that the owner installed in our place — see
      // the WebSocket-listener-unbinding tests in container-connection
      // for the race this prevents.
      this.ws.removeEventListener('close', this.onWebSocketClose);
      this.ws.removeEventListener('error', this.onWebSocketError);
      try {
        this.ws.close();
      } catch {
        // WebSocket may already be closed
      }
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }

  /**
   * Update the upgrade retry budget without recreating the connection. Takes
   * effect on the next `connect()`; an in-flight connect uses the value
   * captured at start. Mirrors `WebSocketTransport.setRetryTimeoutMs`.
   */
  setRetryTimeoutMs(ms: number): void {
    this.retryTimeoutMs = ms;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Run the owner-provided `onClose` callback exactly once per call,
   * swallowing any errors so a buggy listener can't keep the connection
   * object in a half-torn-down state.
   */
  private fireOnClose(): void {
    if (!this.onClose) return;
    try {
      this.onClose();
    } catch (err) {
      this.logger.warn('ContainerControlConnection onClose handler threw', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * WebSocket `close` listener. Defined as a bound arrow field so the
   * same reference can be passed to both `addEventListener` and
   * `removeEventListener` — a fresh anonymous lambda would silently
   * fail to unbind.
   */
  private onWebSocketClose = (): void => {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    this.logger.debug('ContainerControlConnection WebSocket closed');
    if (wasConnected) this.fireOnClose();
  };

  /**
   * WebSocket `error` listener. Same field-form rationale as
   * {@link onWebSocketClose}.
   */
  private onWebSocketError = (): void => {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (wasConnected) this.fireOnClose();
  };

  private async doConnect(): Promise<void> {
    try {
      const response = await this.fetchUpgradeWithRetry();

      if (response.status !== 101) {
        // Try to surface a structured ContainerUnavailableError from the
        // response body so callers get typed context rather than a generic
        // upgrade_failed RPCTransportError.
        const structured = await tryParseContainerUnavailable(response);
        if (structured) throw structured;

        // No structured body. If the status was retryable, we exhausted the
        // retry budget without the container becoming available.
        if (isRetryableWebSocketUpgradeResponse(response)) {
          throw createErrorFromResponse({
            code: ErrorCode.CONTAINER_UNAVAILABLE,
            message: `Container was unavailable after exhausting upgrade retry budget (status ${response.status})`,
            context: { reason: 'rpc_upgrade_failed', retryable: true },
            httpStatus: getHttpStatus(ErrorCode.CONTAINER_UNAVAILABLE),
            suggestion: getSuggestion(
              ErrorCode.CONTAINER_UNAVAILABLE,
              {} as Record<string, unknown>
            ),
            timestamp: new Date().toISOString()
          });
        }

        throw new Error(
          `WebSocket upgrade failed: ${response.status} ${response.statusText}`
        );
      }

      // The Container base class returns the WebSocket on the response object
      // (Cloudflare Workers runtime convention, not standard fetch)
      const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new Error('No WebSocket in upgrade response');
      }

      // Workers WebSockets require explicit accept() before use
      (ws as unknown as { accept: () => void }).accept();

      ws.addEventListener('close', this.onWebSocketClose);
      ws.addEventListener('error', this.onWebSocketError);

      this.ws = ws;
      this.transport.activate(ws);
      this.connected = true;

      this.logger.debug('ContainerControlConnection established', {
        port: this.port
      });
    } catch (error) {
      this.connected = false;
      this.transport.abort(error);
      // Signal the client to discard this connection. The transport is now
      // permanently aborted; any in-flight or future stub calls would fail
      // immediately. Firing onClose here lets the client null out its
      // reference so the next RPC attempt creates a fresh connection.
      this.fireOnClose();
      this.logger.error(
        'ContainerControlConnection failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Issue WebSocket upgrade fetches, retrying transient control-plane
   * unavailability responses until either the upgrade succeeds, a
   * non-retryable status is returned, or the retry budget runs out.
   */
  private async fetchUpgradeWithRetry(): Promise<Response> {
    return fetchWithResponseRetry(() => this.fetchUpgradeAttempt(), {
      retryTimeoutMs: this.retryTimeoutMs,
      minTimeForRetryMs: MIN_TIME_FOR_RETRY_MS,
      logger: this.logger,
      retryLogMessage:
        'ContainerControlConnection upgrade returned retryable status, retrying',
      shouldRetry: isRetryableWebSocketUpgradeResponse
    });
  }

  /**
   * Single WebSocket-upgrade fetch attempt. Owns its own AbortController so
   * each retry gets a fresh per-attempt connect timeout independent of the
   * total retry budget.
   */
  private async fetchUpgradeAttempt(): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      DEFAULT_CONNECT_TIMEOUT_MS
    );

    try {
      const url = `http://localhost:${this.port}/rpc`;
      const request = new Request(url, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        },
        signal: controller.signal
      });
      return await this.containerStub.fetch(request);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred WebSocket transport
// ---------------------------------------------------------------------------

/**
 * RPC transport that queues sends and blocks receives until a WebSocket
 * is provided via `activate()`. Allows the RPC stub to be created before
 * the connection is established — queued calls flush automatically.
 */
export class DeferredTransport implements RpcTransport {
  #ws: WebSocket | null = null;
  #sendQueue: string[] = [];
  #receiveQueue: string[] = [];
  #receiveResolver?: (msg: string) => void;
  #receiveRejecter?: (err: unknown) => void;
  #error?: unknown;

  activate(ws: WebSocket): void {
    this.#ws = ws;

    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.#error) return;
      if (typeof event.data === 'string') {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      } else {
        // Mirrors capnweb's WebSocketTransport. capnweb's wire format is
        // strictly text (JSON), so a binary frame indicates a misbehaving
        // peer. Failing the transport here surfaces the problem to in-flight
        // RPC calls; without it `receive()` would hang forever waiting for
        // a string that is never going to arrive.
        this.#fail(
          new TypeError('Received non-string message from WebSocket.')
        );
      }
    });
    ws.addEventListener('close', (event: CloseEvent) => {
      this.#fail(
        new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`)
      );
    });
    ws.addEventListener('error', () => {
      this.#fail(new Error('WebSocket connection failed.'));
    });

    // Flush queued sends
    for (const msg of this.#sendQueue) {
      ws.send(msg);
    }
    this.#sendQueue = [];
  }

  async send(message: string): Promise<void> {
    if (this.#ws) {
      this.#ws.send(message);
    } else {
      this.#sendQueue.push(message);
    }
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) return this.#receiveQueue.shift()!;
    if (this.#error) throw this.#error;
    return new Promise<string>((resolve, reject) => {
      this.#receiveResolver = resolve;
      this.#receiveRejecter = reject;
    });
  }

  abort(reason: unknown): void {
    this.#fail(reason instanceof Error ? reason : new Error(String(reason)));
    if (this.#ws) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.#ws.close(3000, message);
    }
  }

  #fail(err: unknown): void {
    if (this.#error) return;
    this.#error = err;
    this.#receiveRejecter?.(err);
    this.#receiveResolver = undefined;
    this.#receiveRejecter = undefined;
  }
}
