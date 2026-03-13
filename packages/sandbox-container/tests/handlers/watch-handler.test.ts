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
    cursor: 0,
    changed: false,
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
    checkpointWatch: vi.fn(),
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
      const watch = sampleWatchState();
      (watchService.ensureWatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          watch,
          leaseToken: 'lease-1'
        }
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/ensure', 'POST', {
          path: '/workspace/test',
          resumeToken: 'resume-1'
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        watch: WatchState;
        leaseToken: string;
      };
      expect(body.watch.watchId).toBe(watch.watchId);
      expect(body.leaseToken).toBe('lease-1');
    });

    it('should reject invalid resumeToken on ensure', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest('/api/watch/ensure', 'POST', {
          path: '/workspace/test',
          resumeToken: ''
        }),
        defaultContext
      );

      expect(response.status).toBe(400);
    });

    it('should reject invalid checkpoint cursor', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest('/api/watch/watch-1/checkpoint', 'POST', {
          cursor: -1,
          leaseToken: 'lease-1'
        }),
        defaultContext
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain('cursor must be a non-negative integer');
    });

    it('should require leaseToken for checkpoint requests', async () => {
      const handler = new WatchHandler(
        createMockWatchService(),
        createNoOpLogger()
      );

      const response = await handler.handle(
        makeRequest('/api/watch/watch-1/checkpoint', 'POST', { cursor: 3 }),
        defaultContext
      );

      expect(response.status).toBe(400);
    });

    it('should checkpoint a watch cursor', async () => {
      const watchService = createMockWatchService();
      const watch = sampleWatchState({
        cursor: 3,
        changed: false
      });
      (
        watchService.checkpointWatch as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: {
          checkpointed: true,
          watch
        }
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/watch-1/checkpoint', 'POST', {
          cursor: 3,
          leaseToken: 'lease-1'
        }),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        checkpointed: boolean;
        watch: WatchState;
      };
      expect(body.checkpointed).toBe(true);
      expect(body.watch.cursor).toBe(3);
    });

    it('should fetch watch state', async () => {
      const watchService = createMockWatchService();
      const watch = sampleWatchState({ cursor: 5, changed: true });
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
      expect(body.watch.changed).toBe(true);
    });

    it('should stop a watch', async () => {
      const watchService = createMockWatchService();
      (watchService.stopWatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      });

      const handler = new WatchHandler(watchService, createNoOpLogger());
      const response = await handler.handle(
        makeRequest('/api/watch/watch-1?leaseToken=lease-1', 'DELETE'),
        defaultContext
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { watchId: string };
      expect(body.watchId).toBe('watch-1');
    });
  });
});
