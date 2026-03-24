import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import { Router } from '@sandbox-container/core/router';
import type {
  RequestContext,
  RequestHandler
} from '@sandbox-container/core/types';
import { ContainerBridgeAPI } from '@sandbox-container/handlers/capnweb-bridge';

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }
};

describe('ContainerBridgeAPI', () => {
  let router: Router;
  let bridge: ContainerBridgeAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new Router(mockLogger);
  });

  describe('fetch', () => {
    it('should route GET requests to the router and return status + body', async () => {
      const handler: RequestHandler = async (_req, ctx) => {
        return new Response(
          JSON.stringify({ success: true, status: 'healthy' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      };

      router.register({
        method: 'GET',
        path: '/api/ping',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const result = await bridge.httpFetch('GET', '/api/ping');

      expect(result.status).toBe(200);
      expect(result.body).toBeDefined();
      const parsed = JSON.parse(result.body!);
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe('healthy');
    });

    it('should route POST requests with JSON body', async () => {
      let receivedBody: unknown = null;
      const handler: RequestHandler = async (req, _ctx) => {
        receivedBody = await req.json();
        return new Response(
          JSON.stringify({
            success: true,
            stdout: 'hello\n',
            exitCode: 0
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      };

      router.register({
        method: 'POST',
        path: '/api/execute',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const body = JSON.stringify({
        command: 'echo hello',
        sessionId: 'test-session'
      });
      const result = await bridge.httpFetch('POST', '/api/execute', body);

      expect(result.status).toBe(200);
      expect(receivedBody).toEqual({
        command: 'echo hello',
        sessionId: 'test-session'
      });
      const parsed = JSON.parse(result.body!);
      expect(parsed.stdout).toBe('hello\n');
    });

    it('should propagate error status codes', async () => {
      const handler: RequestHandler = async (_req, _ctx) => {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      router.register({
        method: 'GET',
        path: '/api/process/{id}',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const result = await bridge.httpFetch('GET', '/api/process/nonexistent');

      expect(result.status).toBe(404);
      const parsed = JSON.parse(result.body!);
      expect(parsed.error).toBe('Not found');
    });

    it('should return 404 for unregistered paths', async () => {
      bridge = new ContainerBridgeAPI(router);
      const result = await bridge.httpFetch('GET', '/api/nonexistent');

      expect(result.status).toBe(404);
    });

    it('should include response headers', async () => {
      const handler: RequestHandler = async (_req, _ctx) => {
        return new Response('ok', {
          status: 200,
          headers: {
            'Content-Type': 'text/plain',
            'X-Custom': 'test-value'
          }
        });
      };

      router.register({
        method: 'GET',
        path: '/api/test',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const result = await bridge.httpFetch('GET', '/api/test');

      expect(result.status).toBe(200);
      expect(result.headers).toBeDefined();
      expect(result.headers!['content-type']).toBe('text/plain');
      expect(result.headers!['x-custom']).toBe('test-value');
    });

    it('should handle requests without body', async () => {
      const handler: RequestHandler = async (_req, _ctx) => {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      router.register({
        method: 'DELETE',
        path: '/api/file',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const result = await bridge.httpFetch('DELETE', '/api/file');

      expect(result.status).toBe(200);
    });
  });

  describe('fetchStream', () => {
    it('should return a ReadableStream from a streaming response', async () => {
      const handler: RequestHandler = async (_req, _ctx) => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: output\ndata: {"text":"hello"}\n\n'
              )
            );
            controller.enqueue(
              new TextEncoder().encode(
                'event: output\ndata: {"text":"world"}\n\n'
              )
            );
            controller.close();
          }
        });

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      };

      router.register({
        method: 'POST',
        path: '/api/execute/stream',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const body = JSON.stringify({ command: 'echo hello' });
      const stream = await bridge.httpFetchStream(
        'POST',
        '/api/execute/stream',
        body
      );

      expect(stream).toBeInstanceOf(ReadableStream);

      // Read the stream and verify content
      const reader = stream.getReader();
      const chunks: string[] = [];
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const fullText = chunks.join('');
      expect(fullText).toContain('hello');
      expect(fullText).toContain('world');
    });

    it('should throw on non-ok response', async () => {
      const handler: RequestHandler = async (_req, _ctx) => {
        return new Response(JSON.stringify({ error: 'Command failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      router.register({
        method: 'POST',
        path: '/api/execute/stream',
        handler
      });

      bridge = new ContainerBridgeAPI(router);
      const body = JSON.stringify({ command: 'bad-command' });

      await expect(
        bridge.httpFetchStream('POST', '/api/execute/stream', body)
      ).rejects.toThrow('HTTP error 500');
    });

    it('should throw when response has no body', async () => {
      const handler: RequestHandler = async (_req, _ctx) => {
        return new Response(null, { status: 200 });
      };

      router.register({
        method: 'POST',
        path: '/api/execute/stream',
        handler
      });

      bridge = new ContainerBridgeAPI(router);

      await expect(
        bridge.httpFetchStream('POST', '/api/execute/stream')
      ).rejects.toThrow('No response body');
    });
  });
});
