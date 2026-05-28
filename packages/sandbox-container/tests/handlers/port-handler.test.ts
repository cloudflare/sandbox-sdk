import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger, PortWatchEvent } from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import type { RequestContext } from '@sandbox-container/core/types';
import { PortHandler } from '@sandbox-container/handlers/port-handler';
import type { PortService } from '@sandbox-container/services/port-service';
import type { ProcessService } from '@sandbox-container/services/process-service';

const mockPortService = {
  checkPortReady: vi.fn(),
  destroy: vi.fn()
} as unknown as PortService;

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

const mockProcessService = {
  getProcess: vi.fn()
} as unknown as ProcessService;

const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  },
  sessionId: 'session-456'
};

async function collectEvents(response: Response): Promise<PortWatchEvent[]> {
  const events: PortWatchEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        events.push(JSON.parse(line.slice(6)));
      }
    }
  }

  return events;
}

describe('PortHandler', () => {
  let portHandler: PortHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    portHandler = new PortHandler(
      mockPortService,
      mockProcessService,
      mockLogger
    );
  });

  describe('legacy exposed-port registry endpoints', () => {
    it('does not expose ports through the container-local registry API', async () => {
      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/expose-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: 8080 })
        }),
        mockContext
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as ErrorResponse;
      expect(body.code).toBe('UNKNOWN_ERROR');
      expect(mockPortService.checkPortReady).not.toHaveBeenCalled();
    });

    it('does not list ports through the container-local registry API', async () => {
      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/exposed-ports'),
        mockContext
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as ErrorResponse;
      expect(body.code).toBe('UNKNOWN_ERROR');
      expect(mockPortService.checkPortReady).not.toHaveBeenCalled();
    });

    it('does not unexpose ports through the container-local registry API', async () => {
      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/exposed-ports/8080', {
          method: 'DELETE'
        }),
        mockContext
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as ErrorResponse;
      expect(body.code).toBe('UNKNOWN_ERROR');
      expect(mockPortService.checkPortReady).not.toHaveBeenCalled();
    });

    it('does not proxy through the container-local registry API', async () => {
      const response = await portHandler.handle(
        new Request('http://localhost:3000/proxy/8080/api/data'),
        mockContext
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as ErrorResponse;
      expect(body.code).toBe('UNKNOWN_ERROR');
      expect(mockPortService.checkPortReady).not.toHaveBeenCalled();
    });
  });

  describe('handlePortWatch - POST /api/port-watch', () => {
    it('emits ready when the port becomes available', async () => {
      (
        mockPortService.checkPortReady as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ready: true,
        statusCode: 200
      });

      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/port-watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: 8080 })
        }),
        mockContext
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      await expect(collectEvents(response)).resolves.toEqual([
        { type: 'watching', port: 8080 },
        { type: 'ready', port: 8080, statusCode: 200 }
      ]);
    });

    it('emits process_exited when the watched process terminates', async () => {
      (
        mockProcessService.getProcess as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: { status: 'completed', exitCode: 0 }
      });

      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/port-watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: 8080, processId: 'proc-123' })
        }),
        mockContext
      );

      await expect(collectEvents(response)).resolves.toEqual([
        { type: 'watching', port: 8080 },
        { type: 'process_exited', port: 8080, exitCode: 0 }
      ]);
    });

    it('keeps watching while the watched process is starting', async () => {
      (
        mockProcessService.getProcess as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        success: true,
        data: { status: 'starting' }
      });
      (
        mockPortService.checkPortReady as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        ready: true,
        statusCode: 200
      });

      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/port-watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: 8080, processId: 'proc-123' })
        }),
        mockContext
      );

      await expect(collectEvents(response)).resolves.toEqual([
        { type: 'watching', port: 8080 },
        { type: 'ready', port: 8080, statusCode: 200 }
      ]);
    });

    it('emits error when the port check throws', async () => {
      (
        mockPortService.checkPortReady as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('Connection refused'));

      const response = await portHandler.handle(
        new Request('http://localhost:3000/api/port-watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: 8080 })
        }),
        mockContext
      );

      await expect(collectEvents(response)).resolves.toEqual([
        { type: 'watching', port: 8080 },
        { type: 'error', port: 8080, error: 'Connection refused' }
      ]);
    });
  });
});
