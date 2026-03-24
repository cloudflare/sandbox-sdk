import { newWebSocketRpcSession, type RpcStub } from 'capnweb';
import { BaseTransport } from './base-transport';
import type { TransportConfig, TransportMode } from './types';

/**
 * Default timeout for WebSocket connection establishment
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * RPC interface exposed by the container's capnweb endpoint.
 *
 * Includes the bridge methods (fetch/fetchStream) for backward compatibility
 * with the HTTP-oriented ITransport interface, plus native RPC methods
 * that bypass the HTTP layer for operations like streaming file writes.
 */
export interface ContainerBridgeAPI {
  httpFetch(
    method: string,
    path: string,
    body?: string
  ): Promise<{
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }>;

  httpFetchStream(
    method: string,
    path: string,
    body?: string
  ): Promise<ReadableStream<Uint8Array>>;

  /** Native RPC method for streaming file writes (bypasses HTTP layer) */
  writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    sessionId: string
  ): Promise<{
    success: boolean;
    path: string;
    bytesWritten: number;
    timestamp: string;
  }>;
}

/**
 * capnweb WebSocket transport implementation
 *
 * Uses a capnweb RPC session over WebSocket to communicate with the container.
 * In Stage 1, the container exposes a bridge RpcTarget with fetch() and
 * fetchStream() methods that route to its existing HTTP handler infrastructure.
 *
 * This transport implements ITransport so it can be used interchangeably
 * with HttpTransport and WebSocketTransport.
 */
export class CapnwebTransport extends BaseTransport {
  private stub: RpcStub<ContainerBridgeAPI> | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private ws: WebSocket | null = null;

  constructor(config: TransportConfig) {
    super(config);

    if (!config.wsUrl) {
      throw new Error('wsUrl is required for capnweb transport');
    }
  }

  getMode(): TransportMode {
    return 'capnweb';
  }

  isConnected(): boolean {
    return this.connected && this.stub !== null;
  }

  /**
   * Establish a capnweb WebSocket RPC session to the container.
   *
   * The connection promise is assigned synchronously so concurrent
   * callers share the same connection attempt.
   */
  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

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
   * Disconnect and dispose the capnweb session.
   */
  disconnect(): void {
    this.cleanup();
  }

  /**
   * Transport-specific fetch: delegates to the capnweb bridge stub.
   * Constructs a standard Response from the bridge's return value.
   */
  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    await this.connect();

    const method = (options?.method || 'GET') as string;
    const body = this.extractBody(options?.body);

    const result = await this.stub!.httpFetch(method, path, body);

    return new Response(result.body ?? null, {
      status: result.status,
      headers: result.headers
    });
  }

  /**
   * Streaming fetch: delegates to the capnweb bridge stub's fetchStream.
   * capnweb pipes the ReadableStream with backpressure.
   */
  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    await this.connect();

    const bodyStr =
      body && method === 'POST' ? JSON.stringify(body) : undefined;

    return this.stub!.httpFetchStream(method, path, bodyStr);
  }

  /**
   * Stream a file directly to the container via capnweb's native pipe mechanism.
   * Bypasses the HTTP bridge — the stream flows with automatic backpressure.
   */
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
    await this.connect();
    return this.stub!.writeFileStream(path, stream, sessionId);
  }

  /**
   * Internal connection logic.
   * Uses stub.fetch() for WebSocket upgrade in DO context (same pattern as ws-transport),
   * or standard WebSocket for browser/Node.
   */
  private async doConnect(): Promise<void> {
    if (this.config.stub) {
      await this.connectViaFetch();
    } else {
      await this.connectViaWebSocket();
    }
  }

  /**
   * Connect using fetch-based WebSocket upgrade (Cloudflare Workers/DO context).
   * Routes through the parent Container class that handles WebSocket proxying.
   */
  private async connectViaFetch(): Promise<void> {
    const timeoutMs =
      this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const wsPath = new URL(this.config.wsUrl!).pathname;
      const httpUrl = `http://localhost:${this.config.port || 3000}${wsPath}`;

      const request = new Request(httpUrl, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade'
        },
        signal: controller.signal
      });

      const response = await this.config.stub!.fetch(request);

      clearTimeout(timeout);

      if (response.status !== 101) {
        throw new Error(
          `WebSocket upgrade failed: ${response.status} ${response.statusText}`
        );
      }

      const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new Error('No WebSocket in upgrade response');
      }

      (ws as unknown as { accept: () => void }).accept();

      this.ws = ws;

      // Initialize capnweb RPC session over the WebSocket
      this.stub = newWebSocketRpcSession<ContainerBridgeAPI>(ws);

      this.connected = true;

      this.logger.debug('capnweb connected via fetch', {
        url: this.config.wsUrl
      });
    } catch (error) {
      clearTimeout(timeout);
      this.connected = false;
      this.logger.error(
        'capnweb fetch connection failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Connect using standard WebSocket API (browser/Node/test context).
   */
  private async connectViaWebSocket(): Promise<void> {
    const timeoutMs =
      this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error(`capnweb connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const ws = new WebSocket(this.config.wsUrl!);

        const onOpen = () => {
          clearTimeout(timeout);
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onConnectError);

          this.ws = ws;
          this.stub = newWebSocketRpcSession<ContainerBridgeAPI>(ws);
          this.connected = true;

          this.logger.debug('capnweb connected', {
            url: this.config.wsUrl
          });
          resolve();
        };

        const onConnectError = () => {
          clearTimeout(timeout);
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onConnectError);
          this.connected = false;
          this.logger.error(
            'capnweb connection failed',
            new Error('WebSocket connection failed')
          );
          reject(new Error('WebSocket connection failed'));
        };

        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onConnectError);
      } catch (error) {
        clearTimeout(timeout);
        this.connected = false;
        reject(error);
      }
    });
  }

  /**
   * Extract string body from RequestInit body for the bridge API.
   */
  private extractBody(body: RequestInit['body']): string | undefined {
    if (!body) {
      return undefined;
    }
    if (typeof body === 'string') {
      return body;
    }
    throw new Error(
      `capnweb transport only supports string bodies. Got: ${typeof body}`
    );
  }

  /**
   * Cleanup all resources.
   */
  private cleanup(): void {
    if (this.stub) {
      try {
        (this.stub as unknown as { [Symbol.dispose]?: () => void })[
          Symbol.dispose
        ]?.();
      } catch {
        // Stub may already be disposed
      }
      this.stub = null;
    }
    if (this.ws) {
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
}
