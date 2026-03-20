import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ITransport, TransportConfig, TransportMode } from './types';

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

  /**
   * Fetch with automatic retry for 503 (container starting)
   *
   * This is the primary entry point for making requests. It wraps the
   * transport-specific doFetch() with retry logic for container startup.
   */
  async fetch(path: string, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.doFetch(path, options);
      } catch (error) {
        // A TypeError here means the request body stream was already consumed by a
        // prior attempt and cannot be replayed. Return a synthetic 503 so the caller
        // receives a clean error rather than a raw TypeError.
        if (error instanceof TypeError) {
          this.logger.warn(
            'Request body stream already consumed, cannot retry',
            {
              path,
              mode: this.getMode()
            }
          );
          return new Response(null, {
            status: 503,
            statusText: 'Stream body already consumed'
          });
        }
        throw error;
      }

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
   * Poll /api/ping until the container responds with a non-503 status or the
   * retry budget is exhausted.
   *
   * Call this before sending a non-replayable request body (e.g. a
   * ReadableStream) so the body is only consumed once the container is
   * confirmed ready.  Uses doFetch() directly to avoid the recursive retry
   * loop in fetch().
   */
  async waitForContainer(): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.doFetch('/api/ping', { method: 'GET' });

      if (response.status !== 503) {
        return;
      }

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

      throw new Error(
        `Container failed to become ready after ${attempt + 1} attempts (${Math.floor(elapsed / 1000)}s)`
      );
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
