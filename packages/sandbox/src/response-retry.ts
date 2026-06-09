import type { LogContext, Logger } from '@repo/shared';

const DEFAULT_INITIAL_RETRY_DELAY_MS = 3_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_WEBSOCKET_UPGRADE_STATUSES = new Set([500, 502, 503, 504]);

export function isRetryableWebSocketUpgradeResponse(
  response: Response
): boolean {
  return RETRYABLE_WEBSOCKET_UPGRADE_STATUSES.has(response.status);
}

export interface ResponseRetryOptions {
  retryTimeoutMs: number;
  minTimeForRetryMs: number;
  logger: Logger;
  retryLogMessage: string;
  shouldRetry(response: Response): boolean;
  getRetryLogContext?: (response: Response) => Partial<LogContext>;
  onRetryExhausted?: (params: {
    attempts: number;
    elapsedMs: number;
    response: Response;
  }) => void;
}

/**
 * Retry Response-returning operations while their response remains retryable.
 * The retry budget covers the whole operation; each attempt owns any
 * per-request timeout inside the caller-provided `fetchResponse` function.
 */
export async function fetchWithResponseRetry(
  fetchResponse: () => Promise<Response>,
  options: ResponseRetryOptions
): Promise<Response> {
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    const response = await fetchResponse();

    if (!options.shouldRetry(response)) {
      return response;
    }

    const elapsed = Date.now() - startTime;
    const remaining = options.retryTimeoutMs - elapsed;

    if (remaining <= options.minTimeForRetryMs) {
      options.onRetryExhausted?.({
        attempts: attempt + 1,
        elapsedMs: elapsed,
        response
      });
      return response;
    }

    const delay = Math.min(
      DEFAULT_INITIAL_RETRY_DELAY_MS * 2 ** attempt,
      DEFAULT_MAX_RETRY_DELAY_MS
    );

    options.logger.info(options.retryLogMessage, {
      status: response.status,
      attempt: attempt + 1,
      delayMs: delay,
      remainingSec: Math.floor(remaining / 1000),
      ...options.getRetryLogContext?.(response)
    });

    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    attempt++;
  }
}
