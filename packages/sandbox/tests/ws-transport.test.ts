import type {
  WSError,
  WSRequest,
  WSResponse,
  WSStreamChunk
} from '@repo/shared';
import {
  generateRequestId,
  isWSError,
  isWSRequest,
  isWSResponse,
  isWSStreamChunk
} from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from '../src/clients/transport';

/**
 * Tests for WebSocket protocol types and the WebSocketTransport class.
 *
 * Testing Strategy:
 * - Protocol tests (type guards, serialization): Full unit test coverage here
 * - WebSocketTransport class tests: Limited unit tests for non-connection behavior,
 *   plus comprehensive E2E tests in tests/e2e/websocket-transport.test.ts
 *
 * Why limited WebSocketTransport unit tests:
 * - Tests run in Workers runtime (vitest-pool-workers) where mocking WebSocket
 *   is complex and error-prone
 * - The WebSocketTransport class is tightly coupled to WebSocket - most methods
 *   require an active connection
 * - E2E tests verify the complete request/response cycle, error handling,
 *   streaming, and cleanup against a real container
 */
describe('WebSocket Protocol Types', () => {
  describe('generateRequestId', () => {
    it('should generate unique request IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      const id3 = generateRequestId();

      expect(id1).toMatch(/^ws_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^ws_\d+_[a-z0-9]+$/);
      expect(id3).toMatch(/^ws_\d+_[a-z0-9]+$/);

      // All should be unique
      expect(new Set([id1, id2, id3]).size).toBe(3);
    });

    it('should include timestamp in ID', () => {
      const before = Date.now();
      const id = generateRequestId();
      const after = Date.now();

      // Extract timestamp from ID (format: ws_<timestamp>_<random>)
      const parts = id.split('_');
      const timestamp = parseInt(parts[1], 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('isWSRequest', () => {
    it('should return true for valid WSRequest', () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-123',
        method: 'POST',
        path: '/api/execute',
        body: { command: 'echo hello' }
      };

      expect(isWSRequest(request)).toBe(true);
    });

    it('should return true for minimal WSRequest', () => {
      const request = {
        type: 'request',
        id: 'req-456',
        method: 'GET',
        path: '/api/health'
      };

      expect(isWSRequest(request)).toBe(true);
    });

    it('should return false for non-request types', () => {
      expect(isWSRequest(null)).toBe(false);
      expect(isWSRequest(undefined)).toBe(false);
      expect(isWSRequest('string')).toBe(false);
      expect(isWSRequest({ type: 'response' })).toBe(false);
      expect(isWSRequest({ type: 'error' })).toBe(false);
    });
  });

  describe('isWSResponse', () => {
    it('should return true for valid WSResponse', () => {
      const response: WSResponse = {
        type: 'response',
        id: 'req-123',
        status: 200,
        body: { data: 'test' },
        done: true
      };

      expect(isWSResponse(response)).toBe(true);
    });

    it('should return true for minimal WSResponse', () => {
      const response = {
        type: 'response',
        id: 'req-456',
        status: 404,
        done: false
      };

      expect(isWSResponse(response)).toBe(true);
    });

    it('should return false for non-response types', () => {
      expect(isWSResponse(null)).toBe(false);
      expect(isWSResponse(undefined)).toBe(false);
      expect(isWSResponse('string')).toBe(false);
      expect(isWSResponse({ type: 'error' })).toBe(false);
      expect(isWSResponse({ type: 'stream' })).toBe(false);
      expect(isWSResponse({ type: 'request' })).toBe(false);
    });
  });

  describe('isWSError', () => {
    it('should return true for valid WSError', () => {
      const error: WSError = {
        type: 'error',
        id: 'req-123',
        code: 'NOT_FOUND',
        message: 'Resource not found',
        status: 404
      };

      expect(isWSError(error)).toBe(true);
    });

    it('should return true for WSError without id', () => {
      const error = {
        type: 'error',
        code: 'PARSE_ERROR',
        message: 'Invalid JSON',
        status: 400
      };

      expect(isWSError(error)).toBe(true);
    });

    it('should return false for non-error types', () => {
      expect(isWSError(null)).toBe(false);
      expect(isWSError(undefined)).toBe(false);
      expect(isWSError({ type: 'response' })).toBe(false);
      expect(isWSError({ type: 'stream' })).toBe(false);
    });
  });

  describe('isWSStreamChunk', () => {
    it('should return true for valid WSStreamChunk', () => {
      const chunk: WSStreamChunk = {
        type: 'stream',
        id: 'req-123',
        data: 'chunk data'
      };

      expect(isWSStreamChunk(chunk)).toBe(true);
    });

    it('should return true for WSStreamChunk with event', () => {
      const chunk = {
        type: 'stream',
        id: 'req-456',
        event: 'output',
        data: 'line of output'
      };

      expect(isWSStreamChunk(chunk)).toBe(true);
    });

    it('should return false for non-stream types', () => {
      expect(isWSStreamChunk(null)).toBe(false);
      expect(isWSStreamChunk({ type: 'response' })).toBe(false);
      expect(isWSStreamChunk({ type: 'error' })).toBe(false);
    });
  });

  describe('request headers', () => {
    it('should honor per-request timeout overrides for websocket requests', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          requestTimeoutMs: 1000
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        const wsSend = vi.fn();
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: wsSend,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const requestPromise = (transport as any).request(
          'GET',
          '/api/health',
          undefined,
          undefined,
          3000
        ) as Promise<{ status: number; body: { ok: boolean } }>;

        await Promise.resolve();
        expect(wsSend).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1500);

        const pendingIds = Array.from(
          ((transport as any).pendingRequests as Map<string, unknown>).keys()
        );
        expect(pendingIds).toHaveLength(1);

        (transport as any).handleResponse({
          type: 'response',
          id: pendingIds[0],
          status: 200,
          body: { ok: true },
          done: true
        });

        const response = await requestPromise;
        expect(response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should include headers in websocket requests', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws',
        requestTimeoutMs: 1000
      });

      (transport as any).connect = vi.fn().mockResolvedValue(undefined);
      const wsSend = vi.fn();
      (transport as any).ws = {
        readyState: WebSocket.OPEN,
        send: wsSend,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      };

      const requestPromise = (transport as any).request(
        'GET',
        '/api/health',
        undefined,
        {
          'X-Sandbox-Id': 'sandbox-123',
          'X-Custom-Header': 'custom-value'
        }
      ) as Promise<{ status: number; body: { ok: boolean } }>;

      await Promise.resolve();

      expect(wsSend).toHaveBeenCalledTimes(1);
      const request = JSON.parse(wsSend.mock.calls[0]![0]) as WSRequest;
      expect(request.headers).toEqual({
        'X-Custom-Header': 'custom-value',
        'X-Sandbox-Id': 'sandbox-123'
      });

      const pendingIds = Array.from(
        ((transport as any).pendingRequests as Map<string, unknown>).keys()
      );
      const requestId = pendingIds[0]!;

      (transport as any).handleResponse({
        type: 'response',
        id: requestId,
        status: 200,
        body: { ok: true },
        done: true
      });

      const response = await requestPromise;
      expect(response.status).toBe(200);
    });

    it('should include headers in websocket streaming requests', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          requestTimeoutMs: 1000
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        const wsSend = vi.fn();
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: wsSend,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const streamPromise = transport.fetchStream(
          '/api/watch',
          { path: '/workspace' },
          'POST',
          {
            'X-Sandbox-Id': 'sandbox-stream',
            'Content-Type': 'application/json'
          }
        );

        await Promise.resolve();

        expect(wsSend).toHaveBeenCalledTimes(1);
        const request = JSON.parse(wsSend.mock.calls[0]![0]) as WSRequest;
        expect(request.headers).toEqual({
          'Content-Type': 'application/json',
          'X-Sandbox-Id': 'sandbox-stream'
        });

        const pendingIds = Array.from(
          ((transport as any).pendingRequests as Map<string, unknown>).keys()
        );
        const requestId = pendingIds[0]!;

        (transport as any).handleStreamChunk({
          type: 'stream',
          id: requestId,
          data: '{"type":"watching"}'
        });

        const stream = await streamPromise;
        const reader = stream.getReader();
        const readResult = await reader.read();
        expect(readResult.done).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('stream request first-message handling', () => {
    it('should reject before returning stream when first message is an error response', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          requestTimeoutMs: 1000
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        const wsSend = vi.fn();
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: wsSend,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const streamPromise = (transport as any).requestStream(
          'POST',
          '/api/watch',
          { path: '/workspace' }
        ) as Promise<ReadableStream<Uint8Array>>;

        await Promise.resolve();

        expect(wsSend).toHaveBeenCalledTimes(1);

        const pendingIds = Array.from(
          ((transport as any).pendingRequests as Map<string, unknown>).keys()
        );
        expect(pendingIds).toHaveLength(1);
        const requestId = pendingIds[0]!;

        (transport as any).handleResponse({
          type: 'response',
          id: requestId,
          status: 500,
          body: { error: 'failed' },
          done: true
        });

        await expect(streamPromise).rejects.toThrow('Stream error: 500');
        expect((transport as any).pendingRequests.size).toBe(0);

        vi.advanceTimersByTime(5000);
        expect((transport as any).pendingRequests.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should resolve stream on first chunk and clean up after done response', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          requestTimeoutMs: 1000
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        const wsSend = vi.fn();
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: wsSend,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const streamPromise = (transport as any).requestStream(
          'POST',
          '/api/watch',
          { path: '/workspace' }
        ) as Promise<ReadableStream<Uint8Array>>;

        await Promise.resolve();

        const pendingIds = Array.from(
          ((transport as any).pendingRequests as Map<string, unknown>).keys()
        );
        expect(pendingIds).toHaveLength(1);
        const requestId = pendingIds[0]!;

        (transport as any).handleStreamChunk({
          type: 'stream',
          id: requestId,
          data: '{"type":"watching"}'
        });

        const stream = await streamPromise;
        const reader = stream.getReader();
        const firstRead = await reader.read();
        expect(firstRead.done).toBe(false);

        const firstChunk = new TextDecoder().decode(firstRead.value);
        expect(firstChunk).toContain('data: {"type":"watching"}');

        (transport as any).handleResponse({
          type: 'response',
          id: requestId,
          status: 200,
          done: true
        });

        const secondRead = await reader.read();
        expect(secondRead.done).toBe(true);
        expect((transport as any).pendingRequests.size).toBe(0);

        vi.advanceTimersByTime(5000);
        expect((transport as any).pendingRequests.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reject and clean up when timeout fires before first message', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          streamIdleTimeoutMs: 1000
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const streamPromise = (transport as any).requestStream(
          'POST',
          '/api/watch',
          { path: '/workspace' }
        ) as Promise<ReadableStream<Uint8Array>>;

        await Promise.resolve();
        expect((transport as any).pendingRequests.size).toBe(1);

        vi.advanceTimersByTime(1001);

        await expect(streamPromise).rejects.toThrow(
          'Stream idle timeout after 1000ms'
        );
        expect((transport as any).pendingRequests.size).toBe(0);

        vi.advanceTimersByTime(5000);
        expect((transport as any).pendingRequests.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should error stream and clean up when timeout fires after first chunk', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          streamIdleTimeoutMs: 1000
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const streamPromise = (transport as any).requestStream(
          'POST',
          '/api/watch',
          { path: '/workspace' }
        ) as Promise<ReadableStream<Uint8Array>>;

        await Promise.resolve();

        const pendingIds = Array.from(
          ((transport as any).pendingRequests as Map<string, unknown>).keys()
        );
        expect(pendingIds).toHaveLength(1);
        const requestId = pendingIds[0]!;

        (transport as any).handleStreamChunk({
          type: 'stream',
          id: requestId,
          data: '{"type":"watching"}'
        });

        const stream = await streamPromise;
        const reader = stream.getReader();

        const firstRead = await reader.read();
        expect(firstRead.done).toBe(false);

        vi.advanceTimersByTime(1001);

        await expect(reader.read()).rejects.toThrow(
          'Stream idle timeout after 1000ms'
        );
        expect((transport as any).pendingRequests.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset idle timeout when chunk arrives', async () => {
      vi.useFakeTimers();
      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:3000/ws',
          streamIdleTimeoutMs: 100
        });

        (transport as any).connect = vi.fn().mockResolvedValue(undefined);
        (transport as any).ws = {
          readyState: WebSocket.OPEN,
          send: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn()
        };

        const streamPromise = (transport as any).requestStream(
          'POST',
          '/api/watch',
          { path: '/workspace' }
        ) as Promise<ReadableStream<Uint8Array>>;

        await Promise.resolve();

        const pendingIds = Array.from(
          ((transport as any).pendingRequests as Map<string, unknown>).keys()
        );
        expect(pendingIds).toHaveLength(1);
        const requestId = pendingIds[0]!;

        // Send first chunk to establish stream
        (transport as any).handleStreamChunk({
          type: 'stream',
          id: requestId,
          data: '{"type":"watching"}'
        });

        const stream = await streamPromise;
        const reader = stream.getReader();

        const firstRead = await reader.read();
        expect(firstRead.done).toBe(false);

        // Advance 80ms (before 100ms timeout)
        vi.advanceTimersByTime(80);

        // Send second chunk - this should reset the idle timer
        (transport as any).handleStreamChunk({
          type: 'stream',
          id: requestId,
          data: '{"type":"update"}'
        });

        // Advance 80ms more (total 160ms from start, but only 80ms from last chunk)
        vi.advanceTimersByTime(80);

        // Stream should still be alive - no timeout yet
        const secondRead = await reader.read();
        expect(secondRead.done).toBe(false);
        expect((transport as any).pendingRequests.size).toBe(1);

        // Now advance past the idle timeout from the last chunk (100ms+)
        vi.advanceTimersByTime(101);

        // Stream should now timeout
        await expect(reader.read()).rejects.toThrow(
          'Stream idle timeout after 100ms'
        );
        expect((transport as any).pendingRequests.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('WebSocketTransport', () => {
  describe('initial state', () => {
    it('should not be connected after construction', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      expect(transport.isConnected()).toBe(false);
    });

    it('should accept custom options', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws',
        connectTimeoutMs: 5000,
        requestTimeoutMs: 60000
      });
      expect(transport.isConnected()).toBe(false);
    });

    it('should throw if wsUrl is missing', () => {
      expect(() => {
        new WebSocketTransport({});
      }).toThrow('wsUrl is required for WebSocket transport');
    });
  });

  describe('disconnect', () => {
    it('should be safe to call disconnect when not connected', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      // Should not throw
      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });

    it('should be safe to call disconnect multiple times', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      transport.disconnect();
      transport.disconnect();
      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });

    it('should reconnect after a socket close', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      const transportInternals = transport as unknown as {
        ws: {
          readyState: number;
          send: ReturnType<typeof vi.fn>;
          addEventListener: ReturnType<typeof vi.fn>;
          removeEventListener: ReturnType<typeof vi.fn>;
          close: ReturnType<typeof vi.fn>;
        } | null;
        state: 'disconnected' | 'connecting' | 'connected' | 'error';
        handleClose: (event: CloseEvent) => void;
        doConnect: () => Promise<void>;
      };

      const createSocket = () => ({
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      });

      const doConnect = vi
        .spyOn(transportInternals, 'doConnect')
        .mockImplementation(async () => {
          transportInternals.ws = createSocket();
          transportInternals.state = 'connected';
        });

      await transport.connect();
      expect(doConnect).toHaveBeenCalledTimes(1);

      transportInternals.handleClose({
        code: 1006,
        reason: '',
        wasClean: false
      } as CloseEvent);

      await transport.connect();
      expect(doConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('fetch without connection', () => {
    it('retries 503 upgrade responses with updated retry budget', async () => {
      vi.useFakeTimers();

      try {
        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:8671/ws',
          retryTimeoutMs: 1_000
        });
        transport.setRetryTimeoutMs(20_000);

        const attemptUpgrade = vi
          .fn<() => Promise<Response>>()
          .mockResolvedValueOnce(
            new Response('Container is starting.', {
              status: 503,
              statusText: 'Service Unavailable'
            })
          )
          .mockResolvedValueOnce(
            new Response(null, {
              status: 200,
              statusText: 'OK'
            })
          );

        const connectPromise = (
          transport as unknown as {
            fetchUpgradeWithRetry: (
              attemptUpgrade: () => Promise<Response>
            ) => Promise<Response>;
          }
        ).fetchUpgradeWithRetry(attemptUpgrade);
        await vi.advanceTimersByTimeAsync(0);

        expect(attemptUpgrade).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3_000);
        const response = await connectPromise;

        expect(attemptUpgrade).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it('creates a fresh request for each connectViaFetch retry', async () => {
      vi.useFakeTimers();

      try {
        const ws = {
          accept: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          close: vi.fn(),
          readyState: WebSocket.OPEN
        } as unknown as WebSocket;

        const requests: Request[] = [];
        const stub = {
          containerFetch: vi.fn(),
          fetch: vi
            .fn<(request: Request) => Promise<Response>>()
            .mockImplementationOnce(async (request) => {
              requests.push(request);
              return new Response('Container is starting.', {
                status: 503,
                statusText: 'Service Unavailable'
              });
            })
            .mockImplementationOnce(async (request) => {
              requests.push(request);

              if (request.signal.aborted) {
                throw new Error('retry request reused an aborted signal');
              }

              return {
                status: 101,
                statusText: 'Switching Protocols',
                webSocket: ws
              } as Response;
            })
        };

        const transport = new WebSocketTransport({
          wsUrl: 'ws://localhost:8671/ws',
          stub,
          connectTimeoutMs: 1,
          retryTimeoutMs: 20_000
        });

        const connectPromise = (
          transport as unknown as { connectViaFetch: () => Promise<void> }
        ).connectViaFetch();

        await vi.advanceTimersByTimeAsync(0);
        expect(stub.fetch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3_000);
        await connectPromise;

        expect(stub.fetch).toHaveBeenCalledTimes(2);
        expect(requests).toHaveLength(2);
        expect(requests[0]).not.toBe(requests[1]);
        expect(ws.accept).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should attempt to connect when making a fetch request', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://invalid-url:9999/ws',
        connectTimeoutMs: 100
      });

      // Fetch should fail because connection fails
      await expect(transport.fetch('/test')).rejects.toThrow();
    });

    it('should attempt to connect when making a stream request', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://invalid-url:9999/ws',
        connectTimeoutMs: 100
      });

      // Stream request should fail because connection fails
      await expect(transport.fetchStream('/test')).rejects.toThrow();
    });
  });

  describe('re-entrancy guard (HTTP fallback while connecting)', () => {
    /**
     * These tests verify the fix for a deadlock that occurs when the WebSocket
     * connection is being established (state === 'connecting') and a nested SDK
     * call (e.g. from onStart → exec) tries to use the same transport. Without
     * the guard, the nested call awaits connectPromise — which can't resolve
     * until onStart returns — creating a cycle.
     */

    it('nested fetch during connect() uses HTTP instead of deadlocking', async () => {
      // Simulates the real deadlock scenario:
      //   connect() → connectViaFetch() → stub.fetch() [upgrade request]
      //     → onStart() → exec() → transport.fetch() [nested call]
      //
      // The mocked stub.fetch() (the upgrade path) triggers a nested
      // transport.fetch() before returning. Without the guard, the nested
      // call would await connectPromise and deadlock.
      const httpResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

      let nestedFetchResult: Response | null = null;

      const stub = {
        containerFetch: vi
          .fn<
            (url: string, init: RequestInit, port?: number) => Promise<Response>
          >()
          .mockResolvedValue(httpResponse),
        fetch: vi
          .fn<(request: Request) => Promise<Response>>()
          .mockImplementation(async () => {
            // This runs during connectViaFetch() — state is 'connecting',
            // connectPromise is set. Simulate onStart calling exec():
            nestedFetchResult = await transport.fetch('/api/execute', {
              method: 'POST',
              body: JSON.stringify({ command: 'echo hi' })
            });

            // Return a non-101 to fail the upgrade (we're testing the guard,
            // not the full WebSocket handshake)
            return new Response('not an upgrade', { status: 400 });
          })
      };

      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws',
        port: 3000,
        stub
      });

      // connect() will fail (non-101 response), but the nested fetch should
      // have completed via HTTP fallback without deadlocking
      await expect(transport.fetch('/test')).rejects.toThrow();

      // The nested call should have used containerFetch (HTTP), not stub.fetch (WS)
      expect(stub.fetch).toHaveBeenCalledTimes(1); // only the upgrade attempt
      expect(stub.containerFetch).toHaveBeenCalledTimes(1); // the nested HTTP fallback
      expect(nestedFetchResult).not.toBeNull();
      expect(nestedFetchResult!.status).toBe(200);
    });

    it('fetch falls back to stub.containerFetch when state is connecting', async () => {
      const stubResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

      const stub = {
        containerFetch: vi
          .fn<
            (url: string, init: RequestInit, port?: number) => Promise<Response>
          >()
          .mockResolvedValue(stubResponse),
        fetch: vi.fn<(request: Request) => Promise<Response>>()
      };

      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws',
        port: 3000,
        stub
      });

      const internals = transport as unknown as { state: string };
      internals.state = 'connecting';

      const response = await transport.fetch('/api/execute', {
        method: 'POST',
        body: JSON.stringify({ command: 'echo hi' }),
        headers: { 'Content-Type': 'application/json' }
      });

      expect(stub.containerFetch).toHaveBeenCalledTimes(1);
      expect(stub.fetch).not.toHaveBeenCalled();

      const [url, , port] = stub.containerFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/api/execute');
      expect(port).toBe(3000);
      expect(response.status).toBe(200);
    });

    it('fetchStream falls back to stub.containerFetch when state is connecting', async () => {
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
          controller.close();
        }
      });

      const stub = {
        containerFetch: vi
          .fn<
            (url: string, init: RequestInit, port?: number) => Promise<Response>
          >()
          .mockResolvedValue(new Response(bodyStream, { status: 200 })),
        fetch: vi.fn<(request: Request) => Promise<Response>>()
      };

      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws',
        port: 3000,
        stub
      });

      const internals = transport as unknown as { state: string };
      internals.state = 'connecting';

      const stream = await transport.fetchStream('/api/execute/stream', {
        command: 'ls'
      });

      expect(stub.containerFetch).toHaveBeenCalledTimes(1);
      expect(stub.fetch).not.toHaveBeenCalled();
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('uses normal WebSocket path when state is not connecting', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://invalid-url:9999/ws',
        connectTimeoutMs: 100
      });

      // State is 'disconnected' (default), so it should try to connect via WS
      // and fail — NOT use the HTTP fallback
      await expect(transport.fetch('/test')).rejects.toThrow();
    });
  });
});
