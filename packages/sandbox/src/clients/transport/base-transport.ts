import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type {
  ITransport,
  TransportConfig,
  TransportMode,
  TransportRequestInit
} from './types';

/**
 * Container startup retry configuration
 */
const DEFAULT_RETRY_TIMEOUT_MS = 120_000; // 2 minutes total retry budget
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to retry

/**
 * Abstract base transport with shared retry logic
 *
 * Handles 503 retry for container startup - shared by all transports.
 * Subclasses implement the transport-specific fetch and stream logic.
 */
export abstract class BaseTransport implements ITransport {
  protected config: TransportConfig;
  protected logger: Logger;
  private retryTimeoutMs: number;

  constructor(config: TransportConfig) {
    this.config = config;
    this.logger = config.logger ?? createNoOpLogger();
    this.retryTimeoutMs = config.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
  }

  abstract getMode(): TransportMode;
  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract isConnected(): boolean;

  setRetryTimeoutMs(ms: number): void {
    this.retryTimeoutMs = ms;
  }

  protected getRetryTimeoutMs(): number {
    return this.retryTimeoutMs;
  }

  /**
   * Fetch with automatic retry for 503 (container starting)
   *
   * This is the primary entry point for making requests. It wraps the
   * transport-specific doFetch() with retry logic for container startup.
   */
  async fetch(path: string, options?: TransportRequestInit): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.doFetch(path, options);

      // Check for retryable 503 (container starting)
      if (response.status === 503) {
        const elapsed = Date.now() - startTime;
        const remaining = this.retryTimeoutMs - elapsed;

        if (remaining > MIN_TIME_FOR_RETRY_MS) {
          const delay = Math.min(3000 * 2 ** attempt, 30000);

          this.logger.info('Container not ready, retrying', {
            status: response.status,
            attempt: attempt + 1,
            delayMs: delay,
            remainingSec: Math.floor(remaining / 1000),
            mode: this.getMode()
          });

          await this.sleep(delay);
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
   * Transport-specific fetch implementation (no retry)
   * Subclasses implement the actual HTTP or WebSocket fetch.
   */
  protected abstract doFetch(
    path: string,
    options?: TransportRequestInit
  ): Promise<Response>;

  /**
   * Transport-specific stream implementation
   * Subclasses implement HTTP SSE or WebSocket streaming.
   */
  abstract fetchStream(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST',
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>>;

  // ---------------------------------------------------------------------------
  // Shared HTTP primitives — used by HttpTransport as its primary path and by
  // WebSocketTransport as a fallback during connection establishment.
  // ---------------------------------------------------------------------------

  /**
   * Build a URL targeting the container's HTTP server.
   */
  protected buildContainerUrl(path: string): string {
    if (this.config.stub) {
      return `http://localhost:${this.config.port || 3000}${path}`;
    }
    const baseUrl =
      this.config.baseUrl ?? `http://localhost:${this.config.port || 3000}`;
    return `${baseUrl}${path}`;
  }

  /**
   * Single HTTP request to the container — no WebSocket, no 503 retry.
   */
  protected httpFetch(path: string, options?: RequestInit): Promise<Response> {
    const url = this.buildContainerUrl(path);
    if (this.config.stub) {
      return this.config.stub.containerFetch(
        url,
        options || {},
        this.config.port
      );
    }
    return globalThis.fetch(url, options);
  }

  /**
   * Streaming HTTP request to the container — no WebSocket, no 503 retry.
   */
  protected async httpFetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST',
    headers?: Record<string, string>
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildContainerUrl(path);
    const init: RequestInit = {
      method,
      headers:
        body && method === 'POST'
          ? { ...headers, 'Content-Type': 'application/json' }
          : headers,
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    };

    let response: Response;
    if (this.config.stub) {
      response = await this.config.stub.containerFetch(
        url,
        init,
        this.config.port
      );
    } else {
      response = await globalThis.fetch(url, init);
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

  /**
   * Sleep utility for retry delays
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
