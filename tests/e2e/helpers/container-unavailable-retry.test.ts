import { describe, expect, it, vi } from 'vitest';
import {
  installContainerUnavailableFetchRetry,
  isContainerUnavailableResponse
} from './container-unavailable-retry';

describe('container unavailable fetch retry', () => {
  it('detects structured CONTAINER_UNAVAILABLE responses', async () => {
    const response = new Response(
      JSON.stringify({
        code: 'CONTAINER_UNAVAILABLE',
        message: 'Container is starting',
        context: { reason: 'startup' },
        httpStatus: 503,
        timestamp: new Date().toISOString()
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );

    await expect(isContainerUnavailableResponse(response)).resolves.toBe(true);
    await expect(response.text()).resolves.toContain('CONTAINER_UNAVAILABLE');
  });

  it('leaves unrelated responses alone', async () => {
    const response = new Response(JSON.stringify({ code: 'INTERNAL_ERROR' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });

    await expect(isContainerUnavailableResponse(response)).resolves.toBe(false);
  });

  it('retries container unavailable responses before returning success', async () => {
    vi.useFakeTimers();
    installContainerUnavailableFetchRetry()();
    const realFetch = globalThis.fetch;
    let restore = () => {};
    try {
      const unavailable = new Response(
        JSON.stringify({ code: 'CONTAINER_UNAVAILABLE' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
      const originalFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(unavailable)
        .mockResolvedValueOnce(new Response('ok'));

      restore = installContainerUnavailableFetchRetry({
        fetchImpl: originalFetch,
        setFetch: (next) => {
          globalThis.fetch = next as typeof fetch;
        },
        attempts: 2,
        delayMs: 100
      });

      const responsePromise = fetch('https://example.com/api/execute');
      await vi.advanceTimersByTimeAsync(100);
      const response = await responsePromise;

      expect(await response.text()).toBe('ok');
      expect(originalFetch).toHaveBeenCalledTimes(2);
    } finally {
      restore();
      globalThis.fetch = realFetch;
      vi.useRealTimers();
    }
  });
});
