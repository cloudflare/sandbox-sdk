import { afterEach, describe, expect, it, vi } from 'bun:test';
import { PortService } from '@sandbox-container/services/port-service';

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return values;
      values.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe('PortService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkPortReady', () => {
    it('returns ready for HTTP status in the accepted range', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 204 })
      );
      const service = new PortService();

      const result = await service.checkPortReady({
        port: 8080,
        mode: 'http',
        path: '/health',
        statusMin: 200,
        statusMax: 299
      });

      expect(result).toEqual({ ready: true, statusCode: 204 });
      expect(fetch).toHaveBeenCalledWith('http://localhost:8080/health', {
        method: 'GET',
        signal: expect.any(AbortSignal)
      });
    });

    it('returns not ready for HTTP status outside the accepted range', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('not ready', { status: 503 })
      );
      const service = new PortService();

      const result = await service.checkPortReady({
        port: 8080,
        mode: 'http',
        path: 'health',
        statusMin: 200,
        statusMax: 299
      });

      expect(result).toEqual({
        ready: false,
        statusCode: 503,
        error: 'HTTP status 503 not in expected range 200-299'
      });
      expect(fetch).toHaveBeenCalledWith('http://localhost:8080/health', {
        method: 'GET',
        signal: expect.any(AbortSignal)
      });
    });

    it('returns not ready when the HTTP check throws', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Connection refused')
      );
      const service = new PortService();

      await expect(
        service.checkPortReady({ port: 8080, mode: 'http' })
      ).resolves.toEqual({
        ready: false,
        error: 'Connection refused'
      });
    });
  });

  describe('openWatch', () => {
    it('clears pending polling sleep promptly when cancelled', async () => {
      const service = new PortService();
      vi.spyOn(service, 'checkPortReady').mockResolvedValue({ ready: false });
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const reader = service.openWatch(8080, { interval: 10000 }).getReader();

      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: { type: 'watching', port: 8080 }
      });
      for (let attempt = 0; attempt < 10; attempt++) {
        if (
          (service.checkPortReady as ReturnType<typeof vi.fn>).mock.calls
            .length > 0
        )
          break;
        await Bun.sleep(0);
      }
      expect(service.checkPortReady).toHaveBeenCalledTimes(1);

      await expect(reader.cancel()).resolves.toBeUndefined();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(service.checkPortReady).toHaveBeenCalledTimes(1);
    });

    it('emits typed watching and ready events instead of SSE bytes', async () => {
      const service = new PortService();
      vi.spyOn(service, 'checkPortReady').mockResolvedValue({
        ready: true,
        statusCode: 204
      });

      const events = await readAll(
        service.openWatch(8080, {
          mode: 'http',
          path: '/health',
          status: { min: 200, max: 299 },
          interval: 1
        })
      );

      expect(events).toEqual([
        { type: 'watching', port: 8080 },
        { type: 'ready', port: 8080, statusCode: 204 }
      ]);
      expect(events[0]).not.toBeInstanceOf(Uint8Array);
      expect(service.checkPortReady).toHaveBeenCalledWith({
        port: 8080,
        mode: 'http',
        path: '/health',
        statusMin: 200,
        statusMax: 299
      });
    });

    it('emits typed error events when readiness polling throws', async () => {
      const service = new PortService();
      vi.spyOn(service, 'checkPortReady').mockRejectedValue(new Error('boom'));

      await expect(
        readAll(service.openWatch(8080, { interval: 1 }))
      ).resolves.toEqual([
        { type: 'watching', port: 8080 },
        { type: 'error', port: 8080, error: 'boom' }
      ]);
    });
  });
});
