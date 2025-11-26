import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransport, Transport } from '../src/clients/transport';

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

      const result = await transport.request('GET', '/api/test');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ data: 'test' });
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

      const result = await transport.request('POST', '/api/execute', {
        command: 'echo hello'
      });

      expect(result.status).toBe(200);
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

      const result = await transport.request('GET', '/api/missing');

      expect(result.status).toBe(404);
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

      const stream = await transport.requestStream('POST', '/api/stream', {});

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
        stub: { containerFetch: mockContainerFetch },
        port: 3000
      });

      await transport.request('GET', '/api/test');

      expect(mockContainerFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/test',
        expect.any(Object),
        3000
      );
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(transport.isWebSocketConnected()).toBe(false);
    });

    it('should handle missing WebSocket URL gracefully', () => {
      // When wsUrl is missing, transport is created but won't connect
      const transport = createTransport({
        mode: 'websocket'
        // wsUrl missing - will fail on connect attempt
      });

      // Transport is created but in an invalid state for WebSocket
      expect(transport.getMode()).toBe('websocket');
      expect(transport.isWebSocketConnected()).toBe(false);
    });
  });

  describe('createTransport factory', () => {
    it('should create HTTP transport with minimal options', () => {
      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      expect(transport).toBeInstanceOf(Transport);
      expect(transport.getMode()).toBe('http');
    });

    it('should create WebSocket transport with URL', () => {
      const transport = createTransport({
        mode: 'websocket',
        wsUrl: 'ws://localhost:3000/ws'
      });

      expect(transport).toBeInstanceOf(Transport);
      expect(transport.getMode()).toBe('websocket');
    });

    it('should pass logger to transport', () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn()
      };

      const transport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000',
        logger: mockLogger as any
      });

      expect(transport).toBeDefined();
    });
  });

  describe('mode switching', () => {
    it('should maintain mode throughout lifecycle', async () => {
      const httpTransport = createTransport({
        mode: 'http',
        baseUrl: 'http://localhost:3000'
      });

      expect(httpTransport.getMode()).toBe('http');

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      );

      await httpTransport.request('GET', '/test');

      // Mode should still be http
      expect(httpTransport.getMode()).toBe('http');
    });
  });
});

describe('Transport with SandboxClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should work with shared transport across clients', async () => {
    // Create a shared transport
    const transport = createTransport({
      mode: 'http',
      baseUrl: 'http://localhost:3000'
    });

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    // Multiple requests through same transport
    await transport.request('POST', '/api/mkdir', { path: '/test' });
    await transport.request('POST', '/api/write', { path: '/test/file.txt' });
    await transport.request('GET', '/api/read');

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
