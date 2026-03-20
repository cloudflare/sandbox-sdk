import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTransport,
  HttpTransport,
  WebSocketTransport
} from '../src/clients/transport';

describe('Transport', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('HTTP mode', () => {
    it('should create transport in HTTP mode by default', () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      expect(transport.getMode()).toBe('http');
    });

    it('should make HTTP GET request', async () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ data: 'test' }), { status: 200 })
      );

      const response = await transport.fetch('/api/test', { method: 'GET' });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ data: 'test' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/test',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should make HTTP POST request with body', async () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const response = await transport.fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo hello' })
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/execute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: 'echo hello' })
        })
      );
    });

    it('should handle HTTP errors', async () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      );

      const response = await transport.fetch('/api/missing', { method: 'GET' });

      expect(response.status).toBe(404);
    });

    it('should stream HTTP responses', async () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: test\n\n'));
          controller.close();
        }
      });

      mockFetch.mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const stream = await transport.fetchStream('/api/stream', {});

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should use stub.containerFetch when stub is provided', async () => {
      const mockContainerFetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 })
        );

      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000',
        stub: { containerFetch: mockContainerFetch, fetch: vi.fn() },
        port: 3000
      });

      await transport.fetch('/api/test', { method: 'GET' });

      expect(mockContainerFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/test',
        expect.any(Object),
        3000
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return a synthetic 503 when body stream is already consumed on retry', async () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      // First call returns 503 (container starting), second call throws TypeError
      // simulating the Workers runtime rejecting a re-read of a consumed stream
      mockFetch
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockRejectedValueOnce(
          new TypeError('This ReadableStream is currently locked to a reader')
        );

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        }
      });

      // Use fake timers so the retry sleep doesn't actually wait
      vi.useFakeTimers();
      try {
        const fetchPromise = transport.fetch('/api/write?path=test', {
          method: 'POST',
          body: stream
        });
        // Advance timers past the retry delay (first backoff is 3000ms)
        await vi.runAllTimersAsync();
        const response = await fetchPromise;

        expect(response.status).toBe(503);
        expect(response.statusText).toBe('Stream body already consumed');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('waitForContainer', () => {
      it('should return immediately when /api/ping responds 200', async () => {
        const transport = createTransport({
          mode: 'http',
          baseUrl: 'http://localhost:3000'
        });

        mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

        await expect(transport.waitForContainer()).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:3000/api/ping',
          expect.objectContaining({ method: 'GET' })
        );
      });

      it('should retry when ping returns 503 twice then succeeds', async () => {
        const transport = createTransport({
          mode: 'http',
          baseUrl: 'http://localhost:3000'
        });

        mockFetch
          .mockResolvedValueOnce(new Response('starting', { status: 503 }))
          .mockResolvedValueOnce(new Response('starting', { status: 503 }))
          .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        // Override sleep to avoid real delays in tests
        const sleepSpy = vi
          .spyOn(
            transport as unknown as { sleep: (ms: number) => Promise<void> },
            'sleep'
          )
          .mockResolvedValue(undefined);

        await expect(transport.waitForContainer()).resolves.toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(sleepSpy).toHaveBeenCalledTimes(2);
      });

      it('should throw when all ping attempts return 503 and budget is exhausted', async () => {
        const transport = createTransport({
          mode: 'http',
          baseUrl: 'http://localhost:3000'
        });

        transport.setRetryTimeoutMs(0);
        mockFetch.mockResolvedValue(new Response('starting', { status: 503 }));

        await expect(transport.waitForContainer()).rejects.toThrow(
          'Container failed to become ready'
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('WebSocket mode', () => {
    // Note: Full WebSocket tests are in ws-transport.test.ts
    // These tests verify the Transport wrapper behavior

    it('should create transport in WebSocket mode', () => {
      const transport = createTransport({
        mode: 'websocket',
        wsUrl: 'ws://localhost:3000/ws'
      });

      expect(transport.getMode()).toBe('websocket');
    });

    it('should report WebSocket connection state', () => {
      const transport = createTransport({
        mode: 'websocket',
        wsUrl: 'ws://localhost:3000/ws'
      });

      // Initially not connected
      expect(transport.isConnected()).toBe(false);
    });

    it('should throw error when wsUrl is missing', () => {
      // When wsUrl is missing, WebSocket transport throws an error
      expect(() => {
        createTransport({
          mode: 'websocket'
          // wsUrl missing - should throw
        });
      }).toThrow('wsUrl is required for WebSocket transport');
    });
  });

  describe('createTransport factory', () => {
    it('should create HTTP transport with minimal options', () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      expect(transport).toBeInstanceOf(HttpTransport);
      expect(transport.getMode()).toBe('http');
    });

    it('should create WebSocket transport with URL', () => {
      const transport = createTransport({
        mode: 'websocket',
        wsUrl: 'ws://localhost:3000/ws'
      });

      expect(transport).toBeInstanceOf(WebSocketTransport);
      expect(transport.getMode()).toBe('websocket');
    });
  });
});
