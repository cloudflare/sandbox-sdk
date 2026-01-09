import type { Logger } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ITransport, TransportConfig, TransportMode } from './types';

/**
 * Container startup retry configuration
 */
const TIMEOUT_MS = 120_000; // 2 minutes total retry budget
const MIN_TIME_FOR_RETRY_MS = 15_000; // Need at least 15s remaining to retry

/**
 * Abstract base transport with shared retry logic
 *
 * Handles 503 retry for container startup - shared by all transports.
 * Subclasses implement the transport-specific fetch and stream logic.
 *
 * For real-time messaging (sendMessage, onStreamEvent), WebSocket implements
 * these methods while HTTP throws clear errors explaining WebSocket is required.
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
  abstract sendMessage(message: object): void;
  abstract onStreamEvent(
    streamId: string,
    event: string,
    callback: (data: string) => void
  ): () => void;

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
