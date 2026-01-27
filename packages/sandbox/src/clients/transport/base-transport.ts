import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ITransport, TransportConfig, TransportMode } from './types';

/**
 * Container startup retry configuration
 */
const TIMEOUT_MS = 120_000; // 2 minutes total retry budget
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to retry

/**
 * HTTP status codes that indicate the container is not yet ready.
 *
 * 503: The standard "service unavailable" code returned by the SDK's
 *      containerFetch when the container is still starting up.
 * 500: The container binary (/container-server/sandbox) returns 500
 *      when its internal API hasn't finished initializing, even though
 *      the TCP port is already accepting connections. This creates a
 *      window after startAndWaitForPorts() succeeds where API calls
 *      fail with 500 until the binary is fully ready.
 *
 * See: https://github.com/cloudflare/sandbox-sdk/issues/201
 */
const RETRYABLE_STATUS_CODES = new Set([500, 503]);

/**
 * Abstract base transport with shared retry logic
 *
 * Handles retries for container startup - shared by all transports.
 * Subclasses implement the transport-specific fetch and stream logic.
 */
export abstract class BaseTransport implements ITransport {
  protected config: TransportConfig;
  protected logger: Logger;

  constructor(config: TransportConfig) {
    this.config = config;
    this.logger = config.logger ?? createNoOpLogger();
  }

  abstract getMode(): TransportMode;
  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract isConnected(): boolean;

  /**
   * Fetch with automatic retry for transient container startup errors
   *
   * This is the primary entry point for making requests. It wraps the
   * transport-specific doFetch() with retry logic for container startup.
   *
   * Retries on both 503 (container starting) and 500 (container binary
   * not yet initialized). The container binary returns HTTP 500 during
   * a brief window after the TCP port opens but before the API is ready.
   * Without retrying 500, all API calls fail permanently even though the
   * container will become ready within seconds.
   */
  async fetch(path: string, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.doFetch(path, options);

      // Check for retryable status (container starting or binary not ready)
      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        const elapsed = Date.now() - startTime;
        const remaining = TIMEOUT_MS - elapsed;

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
    options?: RequestInit
  ): Promise<Response>;

  /**
   * Transport-specific stream implementation
   * Subclasses implement HTTP SSE or WebSocket streaming.
   */
  abstract fetchStream(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST'
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Sleep utility for retry delays
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
