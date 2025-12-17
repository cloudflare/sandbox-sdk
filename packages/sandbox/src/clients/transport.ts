import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ContainerStub } from './types';
import { WSTransport } from './ws-transport';

// Container startup retry configuration
const TIMEOUT_MS = 120_000; // 2 minutes total retry budget
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to retry

/**
 * Transport mode for SDK communication
 */
export type TransportMode = 'http' | 'websocket';

/**
 * Transport configuration options
 */
export interface TransportOptions {
  /** Transport mode */
  mode: TransportMode;

  /** Base URL for HTTP mode */
  baseUrl?: string;

  /** WebSocket URL for WebSocket mode */
  wsUrl?: string;

  /** Logger instance */
  logger?: Logger;

  /** Container stub for DO-internal requests */
  stub?: ContainerStub;

  /** Port number */
  port?: number;

  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;
}

/**
 * Transport abstraction layer
 *
 * Provides a unified interface for HTTP and WebSocket transports.
 * The SandboxClient uses this to communicate with the container.
 */
export class Transport {
  private mode: TransportMode;
  private baseUrl: string;
  private wsTransport: WSTransport | null = null;
  private logger: Logger;
  private stub?: ContainerStub;
  private port?: number;

  constructor(options: TransportOptions) {
    this.mode = options.mode;
    this.baseUrl = options.baseUrl ?? 'http://localhost:3000';
    this.logger = options.logger ?? createNoOpLogger();
    this.stub = options.stub;
    this.port = options.port;

    if (this.mode === 'websocket' && options.wsUrl) {
      this.wsTransport = new WSTransport(options.wsUrl, {
        logger: this.logger,
        requestTimeoutMs: options.requestTimeoutMs,
        stub: options.stub,
        port: options.port
      });
    }
  }

  /**
   * Get the current transport mode
   */
  getMode(): TransportMode {
    return this.mode;
  }

  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected(): boolean {
    return this.wsTransport?.isConnected() ?? false;
  }

  /**
   * Connect WebSocket (no-op for HTTP mode)
   */
  async connect(): Promise<void> {
    if (this.mode === 'websocket' && this.wsTransport) {
      await this.wsTransport.connect();
    }
  }

  /**
   * Disconnect WebSocket (no-op for HTTP mode)
   */
  disconnect(): void {
    if (this.wsTransport) {
      this.wsTransport.disconnect();
    }
  }

  /**
   * Fetch-compatible request method with automatic retry for container startup
   *
   * This is the primary entry point for making requests. It handles both HTTP
   * and WebSocket modes transparently and includes retry logic for 503 errors
   * (container starting).
   *
   * @param path - API path (e.g., '/api/execute')
   * @param options - Standard RequestInit options
   * @returns Response object (Fetch API compatible)
   */
  async fetch(path: string, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.doFetch(path, options);

      // Check for retryable 503 (container starting)
      if (response.status === 503) {
        const elapsed = Date.now() - startTime;
        const remaining = TIMEOUT_MS - elapsed;

        if (remaining > MIN_TIME_FOR_RETRY_MS) {
          const delay = Math.min(3000 * 2 ** attempt, 30000);

          this.logger.info('Container not ready, retrying', {
            status: response.status,
            attempt: attempt + 1,
            delayMs: delay,
            remainingSec: Math.floor(remaining / 1000),
            mode: this.mode
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
          continue;
        }

        this.logger.error(
          'Container failed to become ready',
          new Error(
            `Failed after ${attempt + 1} attempts over ${Math.floor(elapsed / 1000)}s`
          )
        );
      }

      return response;
    }
  }

  /**
   * Internal fetch implementation without retry logic
   */
  private async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    if (this.mode === 'websocket' && this.wsTransport) {
      return this.doWebSocketFetch(path, options);
    }
    return this.doHttpFetch(path, options);
  }

  /**
   * HTTP fetch implementation
   */
  private async doHttpFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.stub
      ? `http://localhost:${this.port}${path}`
      : `${this.baseUrl}${path}`;

    if (this.stub) {
      return this.stub.containerFetch(url, options || {}, this.port);
    }
    return globalThis.fetch(url, options);
  }

  /**
   * WebSocket fetch implementation - converts WS response to Response object
   */
  private async doWebSocketFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const method = (options?.method || 'GET') as
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'DELETE';
    let body: unknown;

    if (options?.body) {
      if (typeof options.body === 'string') {
        try {
          body = JSON.parse(options.body);
        } catch {
          body = options.body;
        }
      } else {
        throw new Error(
          `WebSocket transport only supports string bodies. Got: ${typeof options.body}`
        );
      }
    }

    const result = await this.wsTransport!.request(method, path, body);

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * Fetch a streaming response (SSE) with automatic retry for container startup
   *
   * @param path - API path
   * @param body - Optional request body (for POST)
   * @param method - HTTP method (default: POST)
   * @returns ReadableStream for consuming the response
   */
  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    if (this.mode === 'websocket' && this.wsTransport) {
      return this.wsTransport.requestStream(method, path, body);
    }
    return this.doHttpStream(path, body, method);
  }

  /**
   * HTTP streaming implementation
   */
  private async doHttpStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.stub
      ? `http://localhost:${this.port}${path}`
      : `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers:
        body && method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    };

    let response: Response;
    if (this.stub) {
      response = await this.stub.containerFetch(url, options, this.port);
    } else {
      response = await globalThis.fetch(url, options);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }
}

/**
 * Create a transport instance based on options
 */
export function createTransport(options: TransportOptions): Transport {
  return new Transport(options);
}
