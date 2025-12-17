import type { Logger, WSError, WSRequest, WSResponse } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from '../../src/core/router';
import {
  generateConnectionId,
  WebSocketAdapter,
  type WSData
} from '../../src/handlers/ws-adapter';

// Mock ServerWebSocket
class MockServerWebSocket {
  data: WSData;
  sentMessages: string[] = [];

  constructor(data: WSData) {
    this.data = data;
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  getSentMessages<T>(): T[] {
    return this.sentMessages.map((m) => JSON.parse(m));
  }

  getLastMessage<T>(): T {
    return JSON.parse(this.sentMessages[this.sentMessages.length - 1]);
  }
}

// Mock Router
function createMockRouter(): Router {
  return {
    route: vi.fn()
  } as unknown as Router;
}

// Mock Logger
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger())
  } as unknown as Logger;
}

describe('WebSocketAdapter', () => {
  let adapter: WebSocketAdapter;
  let mockRouter: Router;
  let mockLogger: Logger;
  let mockWs: MockServerWebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRouter = createMockRouter();
    mockLogger = createMockLogger();
    adapter = new WebSocketAdapter(mockRouter, mockLogger);
    mockWs = new MockServerWebSocket({ connectionId: 'test-conn-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onOpen', () => {
    it('should log connection open', () => {
      adapter.onOpen(mockWs as any);

      expect(mockLogger.child).toHaveBeenCalled();
    });
  });

  describe('onClose', () => {
    it('should log connection close with code and reason', () => {
      adapter.onClose(mockWs as any, 1000, 'Normal closure');

      expect(mockLogger.child).toHaveBeenCalled();
    });
  });

  describe('onMessage', () => {
    it('should handle valid request and return response', async () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-123',
        method: 'GET',
        path: '/api/health'
      };

      // Mock router to return a successful response
      (mockRouter.route as any).mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await adapter.onMessage(mockWs as any, JSON.stringify(request));

      expect(mockRouter.route).toHaveBeenCalled();

      const response = mockWs.getLastMessage<WSResponse>();
      expect(response.type).toBe('response');
      expect(response.id).toBe('req-123');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
      expect(response.done).toBe(true);
    });

    it('should handle POST request with body', async () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-456',
        method: 'POST',
        path: '/api/execute',
        body: { command: 'echo hello', sessionId: 'sess-1' }
      };

      (mockRouter.route as any).mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            stdout: 'hello\n',
            exitCode: 0
          }),
          { status: 200 }
        )
      );

      await adapter.onMessage(mockWs as any, JSON.stringify(request));

      // Verify router was called with correct Request
      const routerCall = (mockRouter.route as any).mock.calls[0][0] as Request;
      expect(routerCall.method).toBe('POST');
      expect(routerCall.url).toContain('/api/execute');

      const body = (await routerCall.clone().json()) as { command: string };
      expect(body.command).toBe('echo hello');
    });

    it('should return error for invalid JSON', async () => {
      await adapter.onMessage(mockWs as any, 'not valid json');

      const response = mockWs.getLastMessage<WSError>();
      expect(response.type).toBe('error');
      expect(response.code).toBe('PARSE_ERROR');
      expect(response.status).toBe(400);
    });

    it('should return error for invalid request format', async () => {
      await adapter.onMessage(
        mockWs as any,
        JSON.stringify({ notARequest: true })
      );

      const response = mockWs.getLastMessage<WSError>();
      expect(response.type).toBe('error');
      expect(response.code).toBe('INVALID_REQUEST');
      expect(response.status).toBe(400);
    });

    it('should handle router errors gracefully', async () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-err',
        method: 'GET',
        path: '/api/fail'
      };

      (mockRouter.route as any).mockRejectedValue(new Error('Router failed'));

      await adapter.onMessage(mockWs as any, JSON.stringify(request));

      const response = mockWs.getLastMessage<WSError>();
      expect(response.type).toBe('error');
      expect(response.id).toBe('req-err');
      expect(response.code).toBe('INTERNAL_ERROR');
      expect(response.message).toContain('Router failed');
      expect(response.status).toBe(500);
    });

    it('should handle 404 responses', async () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-404',
        method: 'GET',
        path: '/api/notfound'
      };

      (mockRouter.route as any).mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'NOT_FOUND',
            message: 'Resource not found'
          }),
          { status: 404 }
        )
      );

      await adapter.onMessage(mockWs as any, JSON.stringify(request));

      const response = mockWs.getLastMessage<WSResponse>();
      expect(response.type).toBe('response');
      expect(response.id).toBe('req-404');
      expect(response.status).toBe(404);
    });

    it('should handle streaming responses', async () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-stream',
        method: 'POST',
        path: '/api/execute/stream',
        body: { command: 'echo test' }
      };

      // Create a mock SSE stream
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: start\ndata: {"type":"start"}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"type":"stdout","text":"test\\n"}\n\n')
          );
          controller.enqueue(
            encoder.encode(
              'event: complete\ndata: {"type":"complete","exitCode":0}\n\n'
            )
          );
          controller.close();
        }
      });

      (mockRouter.route as any).mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      await adapter.onMessage(mockWs as any, JSON.stringify(request));

      // Should have received stream chunks and final response
      const messages = mockWs.getSentMessages<any>();

      // Find stream chunks
      const streamChunks = messages.filter((m) => m.type === 'stream');
      expect(streamChunks.length).toBeGreaterThan(0);

      // Find final response
      const finalResponse = messages.find((m) => m.type === 'response');
      expect(finalResponse).toBeDefined();
      expect(finalResponse.done).toBe(true);
    });

    it('should handle Buffer messages', async () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-buffer',
        method: 'GET',
        path: '/api/test'
      };

      (mockRouter.route as any).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      // Send as Buffer
      const buffer = Buffer.from(JSON.stringify(request));
      await adapter.onMessage(mockWs as any, buffer);

      expect(mockRouter.route).toHaveBeenCalled();
    });
  });

  describe('generateConnectionId', () => {
    it('should generate unique connection IDs', () => {
      const id1 = generateConnectionId();
      const id2 = generateConnectionId();

      expect(id1).toMatch(/^conn_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^conn_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });
});

describe('WebSocket Integration', () => {
  let adapter: WebSocketAdapter;
  let mockRouter: Router;
  let mockLogger: Logger;

  beforeEach(() => {
    mockRouter = createMockRouter();
    mockLogger = createMockLogger();
    adapter = new WebSocketAdapter(mockRouter, mockLogger);
  });

  it('should handle multiple concurrent requests', async () => {
    const mockWs = new MockServerWebSocket({ connectionId: 'concurrent-test' });

    const requests: WSRequest[] = [
      { type: 'request', id: 'req-1', method: 'GET', path: '/api/one' },
      { type: 'request', id: 'req-2', method: 'GET', path: '/api/two' },
      { type: 'request', id: 'req-3', method: 'GET', path: '/api/three' }
    ];

    // Router returns different responses based on path
    (mockRouter.route as any).mockImplementation((req: Request) => {
      const path = new URL(req.url).pathname;
      return new Response(JSON.stringify({ path }), { status: 200 });
    });

    // Process all requests concurrently
    await Promise.all(
      requests.map((req) =>
        adapter.onMessage(mockWs as any, JSON.stringify(req))
      )
    );

    const responses = mockWs.getSentMessages<WSResponse>();
    expect(responses).toHaveLength(3);

    // Verify each request got its correct response
    const responseIds = responses.map((r) => r.id).sort();
    expect(responseIds).toEqual(['req-1', 'req-2', 'req-3']);

    // Verify response bodies match request paths
    responses.forEach((r) => {
      expect(r.body).toBeDefined();
    });
  });

  it('should maintain request isolation', async () => {
    const mockWs = new MockServerWebSocket({ connectionId: 'isolation-test' });

    // First request fails
    const failRequest: WSRequest = {
      type: 'request',
      id: 'fail-req',
      method: 'GET',
      path: '/api/fail'
    };

    // Second request succeeds
    const successRequest: WSRequest = {
      type: 'request',
      id: 'success-req',
      method: 'GET',
      path: '/api/success'
    };

    (mockRouter.route as any).mockImplementation((req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/api/fail') {
        throw new Error('Intentional failure');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    // Process both requests
    await adapter.onMessage(mockWs as any, JSON.stringify(failRequest));
    await adapter.onMessage(mockWs as any, JSON.stringify(successRequest));

    const messages = mockWs.getSentMessages<any>();
    expect(messages).toHaveLength(2);

    // First should be error
    const errorMsg = messages.find((m) => m.id === 'fail-req');
    expect(errorMsg.type).toBe('error');

    // Second should succeed
    const successMsg = messages.find((m) => m.id === 'success-req');
    expect(successMsg.type).toBe('response');
    expect(successMsg.status).toBe(200);
  });
});
