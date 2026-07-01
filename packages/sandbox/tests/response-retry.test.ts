import { createNoOpLogger } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchWithResponseRetry,
  isRetryableWebSocketUpgradeResponse
} from '../src/response-retry';

function responseWithStatus(status: number): Response {
  return new Response(null, { status });
}

describe('response retry helpers', () => {
  describe('isRetryableWebSocketUpgradeResponse', () => {
    it.each([500, 502, 503, 504])(
      'treats %i as a retryable upgrade response',
      (status) => {
        expect(
          isRetryableWebSocketUpgradeResponse(responseWithStatus(status))
        ).toBe(true);
      }
    );

    it.each([400, 401, 403, 404])(
      'treats %i as a terminal upgrade response',
      (status) => {
        expect(
          isRetryableWebSocketUpgradeResponse(responseWithStatus(status))
        ).toBe(false);
      }
    );
  });

  describe('fetchWithResponseRetry', () => {
    it('retries matching responses until success', async () => {
      vi.useFakeTimers();

      try {
        const fetchResponse = vi
          .fn<() => Promise<Response>>()
          .mockResolvedValueOnce(responseWithStatus(503))
          .mockResolvedValueOnce(responseWithStatus(200));

        const retrying = fetchWithResponseRetry(fetchResponse, {
          retryTimeoutMs: 20_000,
          minTimeForRetryMs: 15_000,
          logger: createNoOpLogger(),
          retryLogMessage: 'retrying test response',
          shouldRetry: (response) => response.status === 503
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchResponse).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3_000);
        const response = await retrying;

        expect(fetchResponse).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns terminal responses without retrying', async () => {
      const fetchResponse = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValue(responseWithStatus(404));

      const response = await fetchWithResponseRetry(fetchResponse, {
        retryTimeoutMs: 20_000,
        minTimeForRetryMs: 15_000,
        logger: createNoOpLogger(),
        retryLogMessage: 'retrying test response',
        shouldRetry: (candidate) => candidate.status === 503
      });

      expect(response.status).toBe(404);
      expect(fetchResponse).toHaveBeenCalledTimes(1);
    });

    it('returns retryable responses when the retry budget is exhausted', async () => {
      const response503 = responseWithStatus(503);
      const fetchResponse = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValue(response503);
      const onRetryExhausted = vi.fn();

      const response = await fetchWithResponseRetry(fetchResponse, {
        retryTimeoutMs: 0,
        minTimeForRetryMs: 15_000,
        logger: createNoOpLogger(),
        retryLogMessage: 'retrying test response',
        shouldRetry: (candidate) => candidate.status === 503,
        onRetryExhausted
      });

      expect(response).toBe(response503);
      expect(fetchResponse).toHaveBeenCalledTimes(1);
      expect(onRetryExhausted).toHaveBeenCalledWith({
        attempts: 1,
        elapsedMs: expect.any(Number),
        response: response503
      });
    });

    it('retries thrown errors matched by shouldRetryError until success', async () => {
      vi.useFakeTimers();

      try {
        const fetchResponse = vi
          .fn<() => Promise<Response>>()
          .mockRejectedValueOnce(new Error('no container instance'))
          .mockResolvedValueOnce(responseWithStatus(200));

        const retrying = fetchWithResponseRetry(fetchResponse, {
          retryTimeoutMs: 20_000,
          minTimeForRetryMs: 15_000,
          logger: createNoOpLogger(),
          retryLogMessage: 'retrying test response',
          shouldRetry: () => false,
          shouldRetryError: (err) =>
            err instanceof Error && err.message === 'no container instance'
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchResponse).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3_000);
        const response = await retrying;

        expect(fetchResponse).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rethrows thrown errors that shouldRetryError does not match', async () => {
      const fetchResponse = vi
        .fn<() => Promise<Response>>()
        .mockRejectedValue(new Error('fatal'));

      await expect(
        fetchWithResponseRetry(fetchResponse, {
          retryTimeoutMs: 20_000,
          minTimeForRetryMs: 15_000,
          logger: createNoOpLogger(),
          retryLogMessage: 'retrying test response',
          shouldRetry: () => false,
          shouldRetryError: (err) =>
            err instanceof Error && err.message === 'no container instance'
        })
      ).rejects.toThrow('fatal');
      expect(fetchResponse).toHaveBeenCalledTimes(1);
    });

    it('rethrows the last error when the retry budget is exhausted', async () => {
      const fetchResponse = vi
        .fn<() => Promise<Response>>()
        .mockRejectedValue(new Error('no container instance'));

      await expect(
        fetchWithResponseRetry(fetchResponse, {
          retryTimeoutMs: 0,
          minTimeForRetryMs: 15_000,
          logger: createNoOpLogger(),
          retryLogMessage: 'retrying test response',
          shouldRetry: () => false,
          shouldRetryError: () => true
        })
      ).rejects.toThrow('no container instance');
      expect(fetchResponse).toHaveBeenCalledTimes(1);
    });

    it('rethrows a thrown error without retrying when no shouldRetryError is provided', async () => {
      const fetchResponse = vi
        .fn<() => Promise<Response>>()
        .mockRejectedValue(new Error('boom'));

      await expect(
        fetchWithResponseRetry(fetchResponse, {
          retryTimeoutMs: 20_000,
          minTimeForRetryMs: 15_000,
          logger: createNoOpLogger(),
          retryLogMessage: 'retrying test response',
          shouldRetry: () => false
        })
      ).rejects.toThrow('boom');
      expect(fetchResponse).toHaveBeenCalledTimes(1);
    });
  });
});
