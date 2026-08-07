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
  /**
   * Decide whether a *thrown* error from `fetchResponse` should be retried.
   * Some backends signal transient unavailability by throwing rather than
   * returning a retryable status (e.g. the Containers platform throwing
   * "There is no container instance..."). When this returns true the error is
   * retried within the same budget as retryable responses; otherwise it is
   * rethrown immediately. Omitted means thrown errors are never retried.
   */
  shouldRetryError?: (error: unknown) => boolean;
  getRetryLogContext?: (response: Response) => Partial<LogContext>;
  onRetryExhausted?: (params: {
    attempts: number;
    elapsedMs: number;
    response: Response;
  }) => void;
}

/**
 * Compute the next backoff delay from the remaining retry budget. Returns null
 * when another attempt should not begin.
 *
 * Delay is limited to the budget left after reserving `minTimeForRetryMs` for
 * the subsequent attempt. An attempt already in progress owns its own
 * per-request timeouts via the caller-provided `fetchResponse` function.
 */
function nextRetryDelayMs(
  attempt: number,
  remainingMs: number,
  minTimeForRetryMs: number
): number | null {
  const availableForDelay = remainingMs - minTimeForRetryMs;
  if (availableForDelay <= 0) {
    return null;
  }

  const computedDelay = Math.min(
    DEFAULT_INITIAL_RETRY_DELAY_MS * 2 ** attempt,
    DEFAULT_MAX_RETRY_DELAY_MS
  );
  return Math.min(computedDelay, availableForDelay);
}

/**
 * Retry Response-returning operations while their response remains retryable.
 *
 * The retry budget decides whether another attempt may begin after a retryable
 * response or thrown error. Each attempt owns any per-request timeout inside
 * the caller-provided `fetchResponse` function. Backoff is limited to the
 * remaining budget after reserving `minTimeForRetryMs` for that next attempt.
 */
export async function fetchWithResponseRetry(
  fetchResponse: () => Promise<Response>,
  options: ResponseRetryOptions
): Promise<Response> {
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    let response: Response;
    try {
      response = await fetchResponse();
    } catch (error) {
      // A thrown error is only retryable when the caller opts in via
      // `shouldRetryError`. Everything else propagates unchanged.
      if (!options.shouldRetryError?.(error)) {
        throw error;
      }

      const elapsed = Date.now() - startTime;
      const remaining = options.retryTimeoutMs - elapsed;
      const delay = nextRetryDelayMs(
        attempt,
        remaining,
        options.minTimeForRetryMs
      );
      if (delay === null) {
        // Budget exhausted — surface the real cause.
        throw error;
      }

      options.logger.info(options.retryLogMessage, {
        attempt: attempt + 1,
        delayMs: delay,
        remainingSec: Math.floor(remaining / 1000),
        error: error instanceof Error ? error.message : String(error)
      });

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      attempt++;
      continue;
    }

    if (!options.shouldRetry(response)) {
      return response;
    }

    const elapsed = Date.now() - startTime;
    const remaining = options.retryTimeoutMs - elapsed;
    const delay = nextRetryDelayMs(
      attempt,
      remaining,
      options.minTimeForRetryMs
    );

    if (delay === null) {
      options.onRetryExhausted?.({
        attempts: attempt + 1,
        elapsedMs: elapsed,
        response
      });
      return response;
    }

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
