import type { WatchState } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { WatchHandler } from '../../src/handlers/watch-handler';
import type { WatchService } from '../../src/services/watch-service';

function sampleWatchState(overrides: Partial<WatchState> = {}): WatchState {
  return {
    watchId: 'watch-1',
    path: '/workspace/test',
    recursive: true,
    include: undefined,
    exclude: ['.git'],
    ownerId: undefined,
    cursor: 0,
    dirty: false,
    overflowed: false,
    lastEventAt: null,
    expiresAt: null,
    subscriberCount: 0,
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

function createMockWatchService(): WatchService {
  return {
    watchDirectory: vi.fn(),
    ensureWatch: vi.fn(),
    getWatchState: vi.fn(),
    ackWatchState: vi.fn(),
    stopWatch: vi.fn()
  } as unknown as WatchService;
}

function makeRequest(
  path: string,
  method: string,
  body?: Record<string, unknown>
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

const defaultContext = {
  traceContext: { traceId: 'test', spanId: 'test' },
  corsHeaders: {},
  requestId: 'test-req',
  timestamp: new Date()
};

describe('WatchHandler', () => {
  describe('stream request validation', () => {
    it('should reject requests with both include and exclude', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest('/api/watch', 'POST', {
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
        makeRequest('/api/watch', 'POST', {
          path: '/workspace/test',
          include: ['*.ts']
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
    });
  });

  describe('persistent watch routes', () => {
    it('should ensure a persistent watch', async () => {
      const watchService = createMockWatchService();
      const watch = sampleWatchState({ ownerId: 'owner-1' });
      (watchService.ensureWatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: watch
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/ensure', 'POST', { path: '/workspace/test' }),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { watch: WatchState };
      expect(body.watch.watchId).toBe(watch.watchId);
      expect(body.watch.ownerId).toBe('owner-1');
    });

    it('should reject invalid ownerId on ensure', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest('/api/watch/ensure', 'POST', {
          path: '/workspace/test',
          ownerId: ''
        }),
        defaultContext
      );

      expect(response.status).toBe(400);
    });

    it('should reject invalid ack cursor', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest('/api/watch/watch-1/ack', 'POST', { cursor: -1 }),
        defaultContext
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain('cursor must be a non-negative integer');
    });

    it('should acknowledge a watch cursor', async () => {
      const watchService = createMockWatchService();
      const watch = sampleWatchState({
        cursor: 3,
        dirty: false,
        ownerId: 'owner-1'
      });
      (
        watchService.ackWatchState as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: {
          acknowledged: true,
          watch
        }
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/watch-1/ack', 'POST', {
          cursor: 3,
          ownerId: 'owner-1'
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        acknowledged: boolean;
        watch: WatchState;
      };
      expect(body.acknowledged).toBe(true);
      expect(body.watch.cursor).toBe(3);
    });

    it('should fetch watch state', async () => {
      const watchService = createMockWatchService();
      const watch = sampleWatchState({ cursor: 5, dirty: true });
      (
        watchService.getWatchState as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: watch
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/watch-1', 'GET'),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { watch: WatchState };
      expect(body.watch.cursor).toBe(5);
      expect(body.watch.dirty).toBe(true);
    });

    it('should stop a watch', async () => {
      const watchService = createMockWatchService();
      (watchService.stopWatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/watch-1?ownerId=owner-1', 'DELETE'),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { watchId: string };
      expect(body.watchId).toBe('watch-1');
    });
  });
});
