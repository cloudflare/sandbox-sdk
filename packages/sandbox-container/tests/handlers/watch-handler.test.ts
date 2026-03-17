import { createNoOpLogger } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { WatchHandler } from '../../src/handlers/watch-handler';
import type { WatchService } from '../../src/services/watch-service';

function createMockWatchService(): WatchService {
  return {
    watchDirectory: vi.fn(),
    checkChanges: vi.fn()
  } as unknown as WatchService;
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const defaultContext = {
  traceContext: { traceId: 'test', spanId: 'test' },
  corsHeaders: {},
  requestId: 'test-req',
  timestamp: new Date()
};

describe('WatchHandler', () => {
  describe('include/exclude validation', () => {
    it('should reject requests with both include and exclude', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest({
          path: '/workspace/test',
          include: ['*.ts'],
          exclude: ['node_modules']
        }),
        defaultContext
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain(
        'include and exclude cannot be used together'
      );
    });

    it('should allow include without exclude', async () => {
      const watchService = createMockWatchService();
      const mockStream = new ReadableStream();
      (
        watchService.watchDirectory as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: mockStream
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());

      const response = await handler.handle(
        makeRequest({ path: '/workspace/test', include: ['*.ts'] }),
        defaultContext
      );

      expect(response.status).toBe(200);
    });

    it('should allow exclude without include', async () => {
      const watchService = createMockWatchService();
      const mockStream = new ReadableStream();
      (
        watchService.watchDirectory as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: mockStream
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());

      const response = await handler.handle(
        makeRequest({
          path: '/workspace/test',
          exclude: ['node_modules']
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
    });

    it('should allow empty include with non-empty exclude', async () => {
      const watchService = createMockWatchService();
      const mockStream = new ReadableStream();
      (
        watchService.watchDirectory as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: mockStream
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());

      const response = await handler.handle(
        makeRequest({
          path: '/workspace/test',
          include: [],
          exclude: ['node_modules']
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
    });
  });

  describe('checkChanges', () => {
    it('should call watchService.checkChanges for valid requests', async () => {
      const watchService = createMockWatchService();
      (watchService.checkChanges as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          success: true,
          data: {
            success: true,
            status: 'changed',
            version: 'watch-1:1',
            timestamp: '2026-03-17T00:00:00.000Z'
          }
        }
      );

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        new Request('http://localhost:3000/api/watch/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'relative/path',
            since: 'watch-1:0'
          })
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
      expect(watchService.checkChanges).toHaveBeenCalledWith(
        '/workspace/relative/path',
        {
          path: '/workspace/relative/path',
          since: 'watch-1:0'
        }
      );
    });

    it('should reject empty since values', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        new Request('http://localhost:3000/api/watch/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/workspace/test',
            since: ''
          })
        }),
        defaultContext
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain('since must be a non-empty string');
    });
  });
});
