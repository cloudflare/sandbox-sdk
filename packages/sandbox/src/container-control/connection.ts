/**
 * Capnweb RPC connection to the container.
 *
 * Manages a single WebSocket session and exposes typed methods that map
 * 1:1 to the container's SandboxAPI. The Sandbox DO calls these directly
 * over the control channel.
 */

import type {
  Logger,
  SandboxAPI,
  SandboxBackupAPI,
  SandboxControlCallback,
  SandboxFilesAPI,
  SandboxPortsAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import {
  ErrorCode,
  type ErrorResponse,
  getHttpStatus,
  getSuggestion
} from '@repo/shared/errors';
import {
  RpcSession,
  type RpcStub,
  type RpcTarget,
  type RpcTransport
} from 'capnweb';
import { createErrorFromResponse } from '../errors/adapter';
import {
  fetchWithResponseRetry,
  isRetryableWebSocketUpgradeResponse
} from '../response-retry';

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

interface StructuredErrorBody {
  code?: string;
  message?: string;
  context?: Record<string, unknown>;
  httpStatus?: number;
  timestamp?: string;
  suggestion?: string;
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ErrorResponse>;
  return (
    typeof candidate.code === 'string' &&
    Object.values(ErrorCode).includes(candidate.code as ErrorCode) &&
    typeof candidate.message === 'string' &&
    typeof candidate.httpStatus === 'number' &&
    typeof candidate.timestamp === 'string' &&
    typeof candidate.context === 'object' &&
    candidate.context !== null
  );
}

function normalizeContainerUnavailableReason(
  reason: unknown
):
  | 'container_starting'
  | 'container_unhealthy'
  | 'container_replaced'
  | 'rpc_upgrade_failed' {
  switch (reason) {
    case 'container_starting':
    case 'container_unhealthy':
    case 'container_replaced':
    case 'rpc_upgrade_failed':
      return reason;
    case 'provisioning':
    case 'startup':
      return 'container_starting';
    case 'container_restarted':
      return 'container_replaced';
    default:
      return 'container_replaced';
  }
}

export interface ContainerControlConnectionOptions {
  stub: ContainerFetchStub;
  port?: number;
  logger?: Logger;
  /**
   * Total retry budget (ms) for retryable upgrade responses while the
   * container is unavailable. Defaults to 120 000 (2 minutes). Set to 0 to
   * disable retries.
   */
  retryTimeoutMs?: number;
  /**
   * Optional `localMain` exposed to the container side of the capnweb
   * session. The container reaches it via
   * `session.getRemoteMain()` and uses it for control-plane callbacks
   * (e.g. notifying the DO when a tunnel's cloudflared process has
   * exited). When omitted, the container sees an empty remote main.
   */
  localMain?: SandboxControlCallback & RpcTarget;
  /**
   * Invoked when an active WebSocket transitions to closed/errored.
   * Fired at most once per successful connection from the WS event
   * handlers in `doConnect`. Gives owners a synchronous teardown
   * signal so recovery doesn't depend on a periodic poller running
   * inside what may be an idle isolate.
   *
   * Also fired for `doConnect` failures after the deferred transport is
   * aborted. A failed upgrade poisons the transport, so owners must discard
   * the connection and create a fresh one for subsequent calls. Not fired for
   * `disconnect()`.
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
  private activeUpgradeAbortController: AbortController | null = null;
  private readonly containerStub: ContainerFetchStub;
  private readonly port: number;
  private readonly logger: Logger;
  private retryTimeoutMs: number;
  private readonly onClose: (() => void) | undefined;
  private readonly disposalError = new Error(
    'Container control connection was disconnected'
  );
  private disposed = false;

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
    if (this.disposed) throw this.disposalError;
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
    if (this.disposed) return;
    this.disposed = true;
    this.activeUpgradeAbortController?.abort();
    this.activeUpgradeAbortController = null;
    if (this.ws) {
      // Unbind first so close/error delivery from transport abortion cannot
      // invoke owner recovery for an explicitly disposed connection.
      this.ws.removeEventListener('close', this.onWebSocketClose);
      this.ws.removeEventListener('error', this.onWebSocketError);
    }
    this.transport.abort(this.disposalError);
    try {
      (this.stub as unknown as Disposable)[Symbol.dispose]?.();
    } catch {
      // Stub may already be disposed
    }
    this.ws = null;
    this.connected = false;
  }

  /**
   * Update the upgrade retry budget without recreating the connection. Takes
   * effect on the next `connect()`; an in-flight connect uses the value
   * captured at start.
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

      if (this.disposed) {
        this.closeUpgradeWebSocket(response);
        throw this.disposalError;
      }

      if (response.status !== 101) {
        const containerUnavailable =
          await this.parseContainerUnavailableUpgradeError(response);
        if (containerUnavailable) {
          throw createErrorFromResponse(containerUnavailable);
        }
        const structuredError =
          await this.parseStructuredUpgradeError(response);
        if (structuredError) {
          throw createErrorFromResponse(structuredError);
        }
        if (isRetryableWebSocketUpgradeResponse(response)) {
          const context = {
            reason: 'rpc_upgrade_failed' as const,
            retryable: true as const
          };
          throw createErrorFromResponse({
            code: ErrorCode.CONTAINER_UNAVAILABLE,
            message:
              'Container was unavailable after exhausting upgrade retry budget.',
            context,
            httpStatus: getHttpStatus(ErrorCode.CONTAINER_UNAVAILABLE),
            timestamp: new Date().toISOString(),
            suggestion: getSuggestion(ErrorCode.CONTAINER_UNAVAILABLE, context)
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
      if (this.disposed) throw this.disposalError;
      this.logger.error(
        'ContainerControlConnection failed',
        error instanceof Error ? error : new Error(String(error))
      );
      this.fireOnClose();
      throw error;
    }
  }

  private closeUpgradeWebSocket(response: Response): void {
    const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
    if (!ws) return;
    try {
      ws.close(3000, this.disposalError.message);
    } catch {
      // A late upgrade may already have closed its WebSocket.
    }
  }

  private async parseStructuredUpgradeError(
    response: Response
  ): Promise<ErrorResponse | null> {
    const body = await this.parseJSONBody(response);
    if (!isErrorResponse(body)) return null;
    return body;
  }

  private async parseContainerUnavailableUpgradeError(
    response: Response
  ): Promise<ErrorResponse | null> {
    const body = await this.parseJSONBody(response);
    if (!body || body.code !== ErrorCode.CONTAINER_UNAVAILABLE) return null;

    const reason = normalizeContainerUnavailableReason(body.context?.reason);
    const context = {
      reason,
      retryable: true as const,
      ...(typeof body.context?.retryAfterMs === 'number' && {
        retryAfterMs: body.context.retryAfterMs
      })
    };

    return {
      code: ErrorCode.CONTAINER_UNAVAILABLE,
      message: body.message ?? 'Container is unavailable',
      context,
      httpStatus:
        typeof body.httpStatus === 'number'
          ? body.httpStatus
          : getHttpStatus(ErrorCode.CONTAINER_UNAVAILABLE),
      timestamp:
        typeof body.timestamp === 'string'
          ? body.timestamp
          : new Date().toISOString(),
      suggestion:
        typeof body.suggestion === 'string'
          ? body.suggestion
          : getSuggestion(ErrorCode.CONTAINER_UNAVAILABLE, context)
    };
  }

  private async parseJSONBody(
    response: Response
  ): Promise<StructuredErrorBody | null> {
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) return null;

    try {
      const body = (await response.clone().json()) as StructuredErrorBody;
      return body && typeof body === 'object' ? body : null;
    } catch {
      return null;
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
    this.activeUpgradeAbortController = controller;
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
      const response = await this.containerStub.fetch(request);
      if (this.disposed) {
        this.closeUpgradeWebSocket(response);
        throw this.disposalError;
      }
      return response;
    } finally {
      clearTimeout(timeout);
      if (this.activeUpgradeAbortController === controller) {
        this.activeUpgradeAbortController = null;
      }
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
    if (this.#error) {
      const message =
        this.#error instanceof Error
          ? this.#error.message
          : String(this.#error);
      ws.close(3000, message);
      throw this.#error;
    }
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
        // Capnweb's wire format is strictly text (JSON), so a binary
        // frame indicates a misbehaving
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
    if (this.#error) throw this.#error;
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
      try {
        this.#ws.close(3000, message);
      } catch {
        // The transport remains failed even if its WebSocket is already closed.
      }
    }
  }

  #fail(err: unknown): void {
    if (this.#error) return;
    this.#error = err;
    this.#sendQueue = [];
    this.#receiveQueue = [];
    this.#receiveRejecter?.(err);
    this.#receiveResolver = undefined;
    this.#receiveRejecter = undefined;
  }
}
