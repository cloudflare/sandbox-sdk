import { afterEach, describe, expect, it, vi } from 'bun:test';
import { PortService } from '@sandbox-container/services/port-service';

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
});
