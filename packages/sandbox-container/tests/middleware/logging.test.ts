import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type { RequestContext } from '@sandbox-container/core/types';
import { LoggingMiddleware } from '@sandbox-container/middleware/logging';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

function makeContext(overrides?: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-test-1',
    timestamp: new Date(),
    corsHeaders: {},
    sessionId: 'session-default',
    sandboxId: 'sandbox-abc123',
    ...overrides
  };
}

function makeRequest(method = 'GET', path = '/api/test'): Request {
  return new Request(`http://localhost:3000${path}`, { method });
}

describe('LoggingMiddleware', () => {
  let middleware: LoggingMiddleware;

  beforeEach(() => {
    vi.clearAllMocks();
    middleware = new LoggingMiddleware(mockLogger);
  });

  it('should log a successful request at debug level with sandboxId', async () => {
    const context = makeContext({ sandboxId: 'sandbox-abc123' });
    const request = makeRequest('POST', '/api/exec');
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200
    });

    const next = vi.fn().mockResolvedValue(mockResponse);
    const response = await middleware.handle(request, context, next);

    expect(response.status).toBe(200);
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();

    const [message, loggedContext] = (
      mockLogger.debug as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(message).toBe('POST /api/exec 200');
    expect(loggedContext.method).toBe('POST');
    expect(loggedContext.pathname).toBe('/api/exec');
    expect(loggedContext.sandboxId).toBe('sandbox-abc123');
    expect(loggedContext.requestId).toBe('req-test-1');
    expect(loggedContext.sessionId).toBe('session-default');
    expect(loggedContext.statusCode).toBe(200);
    expect(typeof loggedContext.durationMs).toBe('number');
  });

  it('should log a 4xx response at debug level', async () => {
    const context = makeContext({ sandboxId: 'sandbox-warn' });
    const request = makeRequest('GET', '/api/missing');
    const mockResponse = new Response('Not found', { status: 404 });

    const next = vi.fn().mockResolvedValue(mockResponse);
    await middleware.handle(request, context, next);

    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();

    const [message, loggedContext] = (
      mockLogger.debug as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(message).toBe('GET /api/missing 404');
    expect(loggedContext.sandboxId).toBe('sandbox-warn');
    expect(loggedContext.statusCode).toBe(404);
  });

  it('should log a 5xx response at warn level', async () => {
    const context = makeContext({ sandboxId: 'sandbox-err' });
    const request = makeRequest('GET', '/api/fail');
    const mockResponse = new Response('Internal error', { status: 500 });

    const next = vi.fn().mockResolvedValue(mockResponse);
    await middleware.handle(request, context, next);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();

    const [message, loggedContext] = (
      mockLogger.warn as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(message).toBe('GET /api/fail 500');
    expect(loggedContext.sandboxId).toBe('sandbox-err');
    expect(loggedContext.statusCode).toBe(500);
  });

  it('should log at warn level and rethrow when next() throws', async () => {
    const context = makeContext({ sandboxId: 'sandbox-throw' });
    const request = makeRequest('DELETE', '/api/crash');
    const thrown = new Error('Handler exploded');

    const next = vi.fn().mockRejectedValue(thrown);

    await expect(middleware.handle(request, context, next)).rejects.toThrow(
      'Handler exploded'
    );

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
    const [message, loggedContext] = (
      mockLogger.warn as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(message).toBe('DELETE /api/crash 500');
    expect(loggedContext.error).toBe('Handler exploded');
    expect(loggedContext.sandboxId).toBe('sandbox-throw');
  });

  it('should include sandboxId as undefined when not provided in context', async () => {
    const contextWithoutSandboxId = makeContext({ sandboxId: undefined });
    const request = makeRequest('GET', '/api/health');
    const mockResponse = new Response('ok', { status: 200 });

    const next = vi.fn().mockResolvedValue(mockResponse);
    await middleware.handle(request, contextWithoutSandboxId, next);

    const [, loggedContext] = (mockLogger.debug as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(loggedContext.sandboxId).toBeUndefined();
  });
});
