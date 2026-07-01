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
import { SandboxError } from '../errors/classes';
import {
  fetchWithResponseRetry,
  isRetryableWebSocketUpgradeResponse
} from '../response-retry';
import { traceEvent, withSpan } from './tracing';

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

  // JSON path: structured CONTAINER_UNAVAILABLE body emitted by the SDK's own
  // container-side handlers.
  if (contentType.includes('application/json')) {
    try {
      const body = (await response.clone().json()) as StructuredErrorBody;
      if (body.code !== ErrorCode.CONTAINER_UNAVAILABLE) return null;

      const reason =
        body.context?.reason === 'container_starting' ||
        body.context?.reason === 'container_unhealthy' ||
        body.context?.reason === 'container_replaced' ||
        body.context?.reason === 'rpc_upgrade_failed' ||
        body.context?.reason === 'no_container_instance_available' ||
        body.context?.reason === 'max_container_instances_exceeded'
          ? body.context.reason
          : 'container_replaced';
      const context = {
        reason,
        retryable: true as const,
        ...(typeof body.context?.retryAfterMs === 'number' && {
          retryAfterMs: body.context.retryAfterMs
        }),
        ...(typeof body.context?.originalMessage === 'string' && {
          originalMessage: body.context.originalMessage
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

  // Plain-text path: the @cloudflare/containers base class returns a plain
  // text 503 ("There is no Container instance available at this time...")
  // when it cannot admit a container. Classify the body so an exhausted retry
  // budget still surfaces a typed ContainerUnavailableError rather than a
  // generic rpc_upgrade_failed.
  try {
    const text = await response.clone().text();
    const match = matchPlatformUnavailable(text);
    if (!match) return null;
    return buildContainerUnavailableError(match.reason, text);
  } catch {
    return null;
  }
}

/**
 * Platform messages emitted by the Containers runtime when it cannot admit a
 * container for a Durable Object during startup. They surface as plain Errors
 * thrown from the container-binding fetch, before the capnweb session is
 * established. Each maps to a categorical `ContainerUnavailableContext.reason`.
 */
const PLATFORM_UNAVAILABLE_SIGNATURES: ReadonlyArray<{
  /** Lowercase substring matched case-insensitively against the error text. */
  substring: string;
  reason:
    | 'no_container_instance_available'
    | 'max_container_instances_exceeded';
}> = [
  {
    // Platform error thrown from the container binding during startup.
    substring:
      'there is no container instance that can be provided to this durable object',
    reason: 'no_container_instance_available'
  },
  {
    // Plain-text 503 body returned by @cloudflare/containers' containerFetch
    // when no instance can be admitted (see container.ts).
    substring: 'there is no container instance available at this time',
    reason: 'no_container_instance_available'
  },
  {
    substring: 'maximum number of running container instances exceeded',
    reason: 'max_container_instances_exceeded'
  }
];

/**
 * Extract a matchable message string from any thrown value.
 *
 * Deliberately avoids `instanceof Error`: the platform's container-admission
 * errors are raised by the workerd container binding, which may live in a
 * different realm than this SDK bundle, so `instanceof Error` can be false
 * even for a genuine Error (the same cross-realm trap documented in
 * container-control/client.ts). Mirrors the base `@cloudflare/containers`
 * `isErrorOfType` helper: coerce to string, then match case-insensitively.
 */
function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return (typeof message === 'string' ? message : String(error)).toLowerCase();
}

/**
 * Find the platform container-admission signature matching a thrown value,
 * or null. Case-insensitive and realm-safe (does not use `instanceof`).
 */
function matchPlatformUnavailable(
  error: unknown
): (typeof PLATFORM_UNAVAILABLE_SIGNATURES)[number] | null {
  const text = errorText(error);
  return (
    PLATFORM_UNAVAILABLE_SIGNATURES.find((sig) =>
      text.includes(sig.substring)
    ) ?? null
  );
}

/**
 * True when a thrown connection-startup error matches a known platform
 * container-admission failure. These are transient: the platform asks the
 * caller to try again later, so they are safe to retry within the budget.
 */
function isPlatformUnavailableError(error: unknown): boolean {
  return matchPlatformUnavailable(error) !== null;
}

/**
 * Build a typed ContainerUnavailableError for a matched platform
 * container-admission failure, preserving the original message verbatim.
 */
function buildContainerUnavailableError(
  reason: (typeof PLATFORM_UNAVAILABLE_SIGNATURES)[number]['reason'],
  originalMessage: string,
  cause?: unknown
): Error {
  const context = {
    reason,
    retryable: true as const,
    originalMessage
  };
  return createErrorFromResponse(
    {
      code: ErrorCode.CONTAINER_UNAVAILABLE,
      message: originalMessage,
      context,
      httpStatus: getHttpStatus(ErrorCode.CONTAINER_UNAVAILABLE),
      suggestion: getSuggestion(ErrorCode.CONTAINER_UNAVAILABLE, context),
      timestamp: new Date().toISOString()
    },
    cause !== undefined ? { cause } : undefined
  );
}

/**
 * Convert a raw connection-startup error into a typed ContainerUnavailableError
 * when it matches a known platform container-admission failure. Returns null
 * for anything else so the caller preserves the original error.
 */
function tryConvertPlatformUnavailable(error: unknown): Error | null {
  // Already a typed SDK error (e.g. thrown by the DO's startContainer hook):
  // preserve it rather than rebuilding an equivalent instance.
  if (error instanceof SandboxError) return error;

  const match = matchPlatformUnavailable(error);
  if (!match) return null;

  const originalMessage =
    error instanceof Error ? error.message : String(error);
  return buildContainerUnavailableError(match.reason, originalMessage, error);
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
   * Lazily resolve sandbox identifiers for trace spans. Queried at span time
   * (not construction) so a name that is set after the client is built — or
   * changes across the connection's lifetime — is reflected. Stamped on spans
   * as `sandbox.id` and `sandbox.name`.
   */
  getSandboxInfo?: () => { id?: string; name?: string };
  /**
   * Optional hook to explicitly start the container (and wait for its ports)
   * before issuing the WebSocket upgrade.
   *
   * When provided, the platform's container-admission failure ("no container
   * instance" / "max instances exceeded") is thrown here — synchronously in
   * the connection's own retry loop — so it is retried within the upgrade
   * budget and, when exhausted, classified and surfaced directly as a typed
   * `ContainerUnavailableError` via `onConnectionError`. This avoids relying
   * on the failure being round-tripped through a 503 upgrade-response body.
   *
   * When omitted, the upgrade fetch itself triggers container start (the
   * legacy behavior, still exercised by unit tests that pass a bare `fetch`
   * stub).
   *
   * Runs under the container's own instance-get / port-ready budget — it is
   * intentionally NOT passed the per-attempt connect-timeout signal, so the
   * base class can run its budget to exhaustion and throw the classifiable
   * no-instance error rather than a generic abort error.
   */
  startContainer?: () => Promise<void>;
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
  /**
   * Invoked with the connection-startup error just before the deferred
   * transport is aborted. Lets the owner capture the *real* failure cause
   * (e.g. a platform container-allocation error) before capnweb replaces it
   * with a generic "RPC session was shut down" message on the queued calls
   * that reject as a result of the abort.
   *
   * Fired at most once per connection attempt. Not fired for `disconnect()`.
   */
  onConnectionError?: (error: unknown) => void;
  /**
   * Invoked once when the WebSocket upgrade succeeds and the capnweb session
   * is live. Lets the owner record that the session actually established a
   * connection to a running container, so a later teardown can be classified
   * as a true interruption rather than a never-connected failure.
   */
  onConnected?: () => void;
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
  private readonly onConnectionError: ((error: unknown) => void) | undefined;
  private readonly onConnected: (() => void) | undefined;
  private readonly startContainer: (() => Promise<void>) | undefined;
  private readonly getSandboxInfo:
    | (() => { id?: string; name?: string })
    | undefined;

  constructor(options: ContainerControlConnectionOptions) {
    this.containerStub = options.stub;
    this.port = options.port ?? 3000;
    this.logger = options.logger ?? createNoOpLogger();
    this.retryTimeoutMs = options.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
    this.onClose = options.onClose;
    this.onConnectionError = options.onConnectionError;
    this.onConnected = options.onConnected;
    this.startContainer = options.startContainer;
    this.getSandboxInfo = options.getSandboxInfo;

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

  /**
   * True while a connection attempt is in progress (upgrade not yet
   * established and not yet failed). Owners use this to avoid tearing the
   * connection down mid-attempt.
   */
  isConnecting(): boolean {
    return this.connectPromise !== null;
  }

  /**
   * Resolve once any in-flight connection attempt settles (success or
   * failure). Resolves immediately when no attempt is in progress. Never
   * rejects — callers only care that the attempt is done.
   */
  async whenSettled(): Promise<void> {
    const pending = this.connectPromise;
    if (!pending) return;
    await pending.catch(() => {});
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

  /**
   * Tear down the connection. `cause` (a lifecycle teardown reason from the
   * owning DO) is used only for the disconnect trace event here; the owner
   * is responsible for stamping it as a *weak* connection cause (one that
   * never overwrites an authoritative failure already captured from a
   * connection attempt), since a teardown is usually a downstream
   * consequence of that earlier failure rather than the root cause.
   */
  disconnect(cause?: unknown): void {
    if (cause !== undefined) {
      traceEvent('sandbox.rpc.disconnect', {
        ...this.spanAttrs(),
        reason: cause instanceof Error ? cause.message : String(cause)
      });
    } else {
      traceEvent('sandbox.rpc.disconnect', this.spanAttrs());
    }
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
   * Base span attributes for this connection: the container port plus the
   * sandbox identifiers (`sandbox.id` = DO id, `sandbox.name` = user name)
   * when available.
   */
  private spanAttrs(): Record<string, string | number | undefined> {
    const info = this.getSandboxInfo?.();
    return {
      'sandbox.rpc.port': this.port,
      'sandbox.id': info?.id,
      'sandbox.name': info?.name
    };
  }

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
   * Run the owner-provided `onConnectionError` callback exactly once per
   * failed connection attempt, swallowing any listener errors.
   */
  private fireConnectionError(error: unknown): void {
    if (!this.onConnectionError) return;
    try {
      this.onConnectionError(error);
    } catch (err) {
      this.logger.warn(
        'ContainerControlConnection onConnectionError handler threw',
        { error: err instanceof Error ? err.message : String(err) }
      );
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
      // Record that a live session was established so a later teardown is
      // classified as a true interruption rather than a never-connected
      // failure. Swallow listener errors like the other fire* helpers.
      try {
        this.onConnected?.();
      } catch (err) {
        this.logger.warn(
          'ContainerControlConnection onConnected handler threw',
          {
            error: err instanceof Error ? err.message : String(err)
          }
        );
      }

      traceEvent('sandbox.rpc.connect', {
        ...this.spanAttrs(),
        outcome: 'established'
      });
      this.logger.debug('ContainerControlConnection established', {
        port: this.port
      });
    } catch (error) {
      this.connected = false;
      // Convert the platform container-allocation failure into a typed
      // ContainerUnavailableError so the real cause survives. capnweb will
      // otherwise mask it: `transport.abort()` below rejects the queued RPC
      // calls with a generic "RPC session was shut down" message.
      const connectionError = tryConvertPlatformUnavailable(error) ?? error;
      // Hand the owner the real cause before aborting the transport, so it can
      // prefer this over the masking disposal error on queued RPC rejections.
      this.fireConnectionError(connectionError);
      this.transport.abort(connectionError);
      // Signal the client to discard this connection. The transport is now
      // permanently aborted; any in-flight or future stub calls would fail
      // immediately. Firing onClose here lets the client null out its
      // reference so the next RPC attempt creates a fresh connection.
      this.fireOnClose();
      this.logger.error(
        'ContainerControlConnection failed',
        connectionError instanceof Error
          ? connectionError
          : new Error(String(connectionError))
      );
      throw connectionError;
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
      shouldRetry: isRetryableWebSocketUpgradeResponse,
      // The Containers platform signals transient container-admission failure
      // by *throwing* (e.g. "There is no container instance...") rather than
      // returning a retryable status. Retry those within the same budget.
      shouldRetryError: isPlatformUnavailableError
    });
  }

  /**
   * Single WebSocket-upgrade fetch attempt.
   *
   * Container start and the upgrade fetch have deliberately separate timeout
   * scopes:
   *
   *   - `startContainer()` runs under the base `Container` class's own
   *     instance-get / port-ready budget. It must NOT be cut short by the
   *     per-attempt connect timeout: the base class only emits the
   *     classifiable `NO_CONTAINER_INSTANCE_ERROR` after its internal budget
   *     is exhausted, and it checks its abort signal *before* that throw
   *     (see @cloudflare/containers `doStartContainer`). Aborting it early
   *     yields a generic "Aborted waiting for container to start" error that
   *     we can't classify — which is what masked the real cause as
   *     OPERATION_INTERRUPTED. Letting it run its own budget means the
   *     platform capacity failure throws here, in our retry loop, where
   *     `shouldRetryError` retries it and `doConnect`'s catch converts it to
   *     a typed ContainerUnavailableError.
   *
   *   - The WebSocket upgrade fetch gets its own fresh AbortController so
   *     each retry has an independent connect timeout for the *upgrade only*.
   */
  private async fetchUpgradeAttempt(): Promise<Response> {
    return withSpan(
      'sandbox.rpc.connect.attempt',
      this.spanAttrs(),
      async () => {
        // Explicitly start the container first (when a hook is provided),
        // under its own budget — no per-attempt abort signal.
        if (this.startContainer) {
          try {
            await this.startContainer();
          } catch (error) {
            // Stamp the real cause on the owner as soon as the first
            // container-admission failure surfaces — before any retry/abort
            // can mask it — so a teardown mid-retry still surfaces this.
            this.fireConnectionError(
              tryConvertPlatformUnavailable(error) ?? error
            );
            throw error;
          }
        }

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
    );
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
