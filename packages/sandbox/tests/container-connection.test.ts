import { describe, expect, it, vi } from 'vitest';
import {
  ContainerControlConnection,
  DeferredTransport
} from '../src/container-control/connection';
import { ContainerUnavailableError, ErrorCode } from '../src/errors';

/**
 * Tests for ContainerControlConnection — the capnweb RPC connection manager.
 *
 * These tests verify connection lifecycle and RPC stub access.
 * The actual RPC methods are tested via E2E tests against a real container.
 */
describe('ContainerControlConnection', () => {
  describe('initial state', () => {
    it('should not be connected after construction', () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      expect(conn.isConnected()).toBe(false);
    });

    it('should have a stub available immediately after construction', () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      expect(conn.rpc()).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should be safe to call disconnect when not connected', () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      conn.disconnect();
      expect(conn.isConnected()).toBe(false);
    });

    it('should be safe to call disconnect multiple times', () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      conn.disconnect();
      conn.disconnect();
      conn.disconnect();
      expect(conn.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('should fail when WebSocket upgrade is rejected', async () => {
      const conn = new ContainerControlConnection({
        stub: {
          fetch: vi
            .fn()
            .mockResolvedValue(new Response('Not Found', { status: 404 }))
        }
      });

      await expect(conn.connect()).rejects.toThrow(
        'WebSocket upgrade failed: 404'
      );
      expect(conn.isConnected()).toBe(false);
    });

    it('should notify the owner when WebSocket upgrade fails', async () => {
      const onClose = vi.fn();
      const conn = new ContainerControlConnection({
        stub: {
          fetch: vi
            .fn()
            .mockResolvedValue(new Response('Not Found', { status: 404 }))
        },
        onClose
      });

      await expect(conn.connect()).rejects.toThrow(
        'WebSocket upgrade failed: 404'
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should reject pending RPC calls when connection fails', async () => {
      const conn = new ContainerControlConnection({
        stub: {
          fetch: vi
            .fn()
            .mockResolvedValue(new Response('Not Found', { status: 404 }))
        }
      });

      // rpc() triggers connect() in the background and returns the stub.
      const stub = conn.rpc();

      // Calling a method on the stub queues a send and starts a receive().
      // Without the fix, this would hang forever because doConnect()'s
      // failure never propagated to the transport.
      const rpcCall = stub.utils.ping();

      await expect(rpcCall).rejects.toThrow();
    }, 5000);
  });

  describe('rpc', () => {
    it('should trigger connect lazily when calling rpc()', () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('Not Found', { status: 404 }));
      const conn = new ContainerControlConnection({
        stub: { fetch: fetchMock }
      });

      // rpc() returns the stub immediately and triggers connect in the background
      const stub = conn.rpc();
      expect(stub).toBeDefined();
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe('connection lifecycle with mocked internals', () => {
    it('should return connected after successful connect', async () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
        internals.connected = true;
        internals.ws = { close: vi.fn(), removeEventListener: vi.fn() };
      });

      await conn.connect();
      expect(conn.isConnected()).toBe(true);
    });

    it('should return the same stub before and after connect', async () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
        internals.connected = true;
        internals.ws = { close: vi.fn(), removeEventListener: vi.fn() };
      });

      // rpc() returns the stub immediately — same reference before and after connect
      const stubBefore = conn.rpc();
      await conn.connect();
      const stubAfter = conn.rpc();
      expect(stubAfter).toBe(stubBefore);
    });

    it('should disconnect and reconnect', async () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      const doConnect = vi
        .spyOn(internals, 'doConnect')
        .mockImplementation(async () => {
          internals.connected = true;
          internals.ws = { close: vi.fn(), removeEventListener: vi.fn() };
        });

      await conn.connect();
      expect(doConnect).toHaveBeenCalledTimes(1);

      conn.disconnect();
      expect(conn.isConnected()).toBe(false);

      await conn.connect();
      expect(doConnect).toHaveBeenCalledTimes(2);
    });

    it('should share connection across concurrent connect() calls', async () => {
      const conn = new ContainerControlConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      const doConnect = vi
        .spyOn(internals, 'doConnect')
        .mockImplementation(async () => {
          internals.connected = true;
          internals.ws = { close: vi.fn(), removeEventListener: vi.fn() };
        });

      await Promise.all([conn.connect(), conn.connect()]);
      expect(doConnect).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Minimal EventTarget-based fake that satisfies the bits of WebSocket the
   * DeferredTransport actually uses: addEventListener('message'|'close'|'error')
   * and `send()`. Avoids the workerd test environment's restriction on
   * constructing real WebSockets in unit tests.
   */
  function createFakeWebSocket(): {
    ws: WebSocket;
    emitMessage: (data: unknown) => void;
    emitClose: (code: number, reason: string) => void;
    emitError: () => void;
    sent: string[];
  } {
    const target = new EventTarget();
    const sent: string[] = [];
    const ws = Object.assign(target, {
      send: (msg: string) => {
        sent.push(msg);
      },
      close: () => {}
    }) as unknown as WebSocket;
    return {
      ws,
      emitMessage: (data) =>
        target.dispatchEvent(
          Object.assign(new Event('message'), { data }) as MessageEvent
        ),
      emitClose: (code, reason) =>
        target.dispatchEvent(
          Object.assign(new Event('close'), { code, reason }) as CloseEvent
        ),
      emitError: () => target.dispatchEvent(new Event('error')),
      sent
    };
  }

  describe('DeferredTransport', () => {
    it('rejects pending receive() with a TypeError when a non-string frame arrives', async () => {
      const fake = createFakeWebSocket();
      const transport = new DeferredTransport();
      transport.activate(fake.ws);

      const recv = transport.receive();
      fake.emitMessage(new ArrayBuffer(8));

      await expect(recv).rejects.toBeInstanceOf(TypeError);
      await expect(recv).rejects.toThrow(
        'Received non-string message from WebSocket.'
      );
    });

    it('fails subsequent receive() calls after a binary frame, matching capnweb parity', async () => {
      const fake = createFakeWebSocket();
      const transport = new DeferredTransport();
      transport.activate(fake.ws);

      fake.emitMessage(new Uint8Array([1, 2, 3]));

      // The transport is now poisoned: any further receive() must reject
      // immediately rather than hang waiting for a frame that won't come.
      await expect(transport.receive()).rejects.toBeInstanceOf(TypeError);
    });

    it('still passes through string frames before any binary frame', async () => {
      const fake = createFakeWebSocket();
      const transport = new DeferredTransport();
      transport.activate(fake.ws);

      fake.emitMessage('hello');
      await expect(transport.receive()).resolves.toBe('hello');
    });

    it('surfaces close events as a Peer closed WebSocket error', async () => {
      const fake = createFakeWebSocket();
      const transport = new DeferredTransport();
      transport.activate(fake.ws);

      const recv = transport.receive();
      fake.emitClose(1006, 'gone');

      await expect(recv).rejects.toThrow(/Peer closed WebSocket: 1006 gone/);
    });

    it('surfaces error events as a WebSocket connection failed error', async () => {
      const fake = createFakeWebSocket();
      const transport = new DeferredTransport();
      transport.activate(fake.ws);

      const recv = transport.receive();
      fake.emitError();

      await expect(recv).rejects.toThrow('WebSocket connection failed.');
    });
  });

  describe('WebSocket upgrade retry', () => {
    /**
     * Build a fake successful upgrade Response. Mirrors what
     * Cloudflare's Container base class returns from `stub.fetch()`:
     * a Response with `status === 101` and a non-standard `webSocket`
     * property carrying the WebSocket instance.
     */
    function makeUpgradeResponse(): Response {
      const target = new EventTarget();
      const ws = Object.assign(target, {
        send: () => {},
        close: () => {},
        accept: () => {}
      }) as unknown as WebSocket;
      // The workerd test runtime rejects new Response(null, { status: 101 }),
      // so synthesize a Response-shaped object exposing only the fields
      // ContainerControlConnection actually reads (status, statusText,
      // and the non-standard `webSocket` accessor).
      return {
        status: 101,
        statusText: 'Switching Protocols',
        webSocket: ws
      } as unknown as Response;
    }

    function makeUpgradeFailure(status: number): Response {
      return new Response('Container upgrade unavailable.', {
        status,
        statusText: 'Service Unavailable'
      });
    }

    it('retries retryable upgrade responses until success', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi
          .fn<(req: Request) => Promise<Response>>()
          .mockResolvedValueOnce(makeUpgradeFailure(500))
          .mockResolvedValueOnce(makeUpgradeFailure(500))
          .mockResolvedValueOnce(makeUpgradeResponse());

        const conn = new ContainerControlConnection({
          stub: { fetch: fetchMock },
          retryTimeoutMs: 60_000
        });

        const connectPromise = conn.connect();
        // First attempt fires synchronously.
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Backoff is 3s for attempt 1, 6s for attempt 2.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(6_000);
        await connectPromise;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(conn.isConnected()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces container unavailability once upgrade retry budget is exhausted', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi
          .fn<(req: Request) => Promise<Response>>()
          .mockResolvedValue(makeUpgradeFailure(500));

        const conn = new ContainerControlConnection({
          stub: { fetch: fetchMock },
          // 20s budget. Walk-through with MIN_TIME_FOR_RETRY_MS = 15s and
          // 3s/6s/12s exponential backoff:
          //   attempt 1 at t=0   (remaining 20s, retry after 3s)
          //   attempt 2 at t=3s  (remaining 17s, retry after 6s)
          //   attempt 3 at t=9s  (remaining 11s < 15s, give up)
          retryTimeoutMs: 20_000
        });

        const connectPromise = conn.connect();
        const assertion = expect(connectPromise).rejects.toMatchObject({
          name: 'ContainerUnavailableError',
          code: ErrorCode.CONTAINER_UNAVAILABLE,
          context: { reason: 'rpc_upgrade_failed', retryable: true }
        });

        // Run all timers — connect() must settle even with fake timers.
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;

        expect(conn.isConnected()).toBe(false);
        // Three attempts before remaining < MIN_TIME_FOR_RETRY_MS.
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    function makeContainerUnavailableResponse(): Response {
      return new Response(
        JSON.stringify({
          code: ErrorCode.CONTAINER_UNAVAILABLE,
          message: 'Container is starting. Please retry in a moment.',
          context: { reason: 'container_starting', retryable: true },
          httpStatus: 503,
          timestamp: new Date().toISOString(),
          suggestion: 'Retry the operation in a moment.'
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    it('preserves structured container unavailability upgrade failures', async () => {
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockResolvedValue(makeContainerUnavailableResponse());

      const conn = new ContainerControlConnection({
        stub: { fetch: fetchMock },
        retryTimeoutMs: 0
      });

      let thrown: unknown;
      try {
        await conn.connect();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ContainerUnavailableError);
      expect(thrown).toMatchObject({
        name: 'ContainerUnavailableError',
        code: ErrorCode.CONTAINER_UNAVAILABLE,
        context: { reason: 'container_starting', retryable: true }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fills defaults for partial container unavailable upgrade bodies', async () => {
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              code: ErrorCode.CONTAINER_UNAVAILABLE,
              message: 'Container is replacing its runtime.'
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        );

      const conn = new ContainerControlConnection({
        stub: { fetch: fetchMock },
        retryTimeoutMs: 0
      });

      await expect(conn.connect()).rejects.toMatchObject({
        name: 'ContainerUnavailableError',
        code: ErrorCode.CONTAINER_UNAVAILABLE,
        context: { reason: 'container_replaced', retryable: true }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('preserves structured container unavailability for queued RPC calls', async () => {
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockResolvedValue(makeContainerUnavailableResponse());

      const conn = new ContainerControlConnection({
        stub: { fetch: fetchMock },
        retryTimeoutMs: 0
      });

      const rpcCall = conn.rpc().utils.ping();

      await expect(rpcCall).rejects.toMatchObject({
        name: 'ContainerUnavailableError',
        code: ErrorCode.CONTAINER_UNAVAILABLE,
        context: { reason: 'container_starting', retryable: true }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry terminal upgrade failures', async () => {
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockResolvedValue(new Response('Not retryable', { status: 404 }));

      const conn = new ContainerControlConnection({
        stub: { fetch: fetchMock },
        retryTimeoutMs: 120_000
      });

      await expect(conn.connect()).rejects.toThrow(
        'WebSocket upgrade failed: 404'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('disables retries when retryTimeoutMs is set to 0', async () => {
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockResolvedValue(makeUpgradeFailure(500));

      const conn = new ContainerControlConnection({
        stub: { fetch: fetchMock },
        retryTimeoutMs: 0
      });

      await expect(conn.connect()).rejects.toMatchObject({
        name: 'ContainerUnavailableError',
        code: ErrorCode.CONTAINER_UNAVAILABLE,
        context: { reason: 'rpc_upgrade_failed', retryable: true }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uses a default retry budget when retryTimeoutMs is omitted', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi
          .fn<(req: Request) => Promise<Response>>()
          .mockResolvedValueOnce(makeUpgradeFailure(503))
          .mockResolvedValueOnce(makeUpgradeResponse());

        const conn = new ContainerControlConnection({
          stub: { fetch: fetchMock }
        });

        const connectPromise = conn.connect();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_000);
        await connectPromise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(conn.isConnected()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('respects setRetryTimeoutMs() updates made before connect()', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi
          .fn<(req: Request) => Promise<Response>>()
          .mockResolvedValue(makeUpgradeFailure(503));

        const conn = new ContainerControlConnection({
          stub: { fetch: fetchMock },
          // Start with a very large budget — would normally allow many retries.
          retryTimeoutMs: 600_000
        });

        // Lower the budget so the very first elapsed-time check gives up.
        conn.setRetryTimeoutMs(1_000);

        const connectPromise = conn.connect();
        const assertion = expect(connectPromise).rejects.toMatchObject({
          name: 'ContainerUnavailableError',
          code: ErrorCode.CONTAINER_UNAVAILABLE,
          context: { reason: 'rpc_upgrade_failed', retryable: true }
        });

        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;

        // Budget too small to satisfy MIN_TIME_FOR_RETRY_MS — no retries.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes a fresh, non-aborted Request to each retry attempt', async () => {
      vi.useFakeTimers();
      try {
        const seenRequests: Request[] = [];
        const fetchMock = vi
          .fn<(req: Request) => Promise<Response>>()
          .mockImplementationOnce(async (req) => {
            seenRequests.push(req);
            return makeUpgradeFailure(503);
          })
          .mockImplementationOnce(async (req) => {
            seenRequests.push(req);
            if (req.signal.aborted) {
              throw new Error('retry reused an aborted signal');
            }
            return makeUpgradeResponse();
          });

        const conn = new ContainerControlConnection({
          stub: { fetch: fetchMock },
          retryTimeoutMs: 60_000
        });

        const connectPromise = conn.connect();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_000);
        await connectPromise;

        expect(seenRequests).toHaveLength(2);
        expect(seenRequests[0]).not.toBe(seenRequests[1]);
        expect(seenRequests[1].signal.aborted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * When a peer-closed WebSocket triggers an `onClose` callback that
   * destroys the connection and creates a new one, we must not let a
   * stale `close` / `error` event from the old WebSocket arrive later
   * and clobber the successor connection. The connection guards against
   * this by unbinding its own listeners from the underlying WebSocket
   * inside `disconnect()`, so any event the runtime dispatches after we
   * decide the connection is dead becomes a no-op.
   */
  describe('WebSocket listener unbinding', () => {
    /**
     * Fake WebSocket that records every (un)bind so we can assert
     * `disconnect()` cleans up the listeners it registered in
     * `doConnect()`.
     */
    function createTrackedWebSocket(): {
      ws: WebSocket;
      listenerCount: (type: string) => number;
      emitClose: (code: number, reason: string) => void;
      emitError: () => void;
    } {
      const target = new EventTarget();
      const counts: Record<string, number> = {};

      const addListener = (type: string, listener: EventListener): void => {
        counts[type] = (counts[type] ?? 0) + 1;
        target.addEventListener(type, listener);
      };
      const removeListener = (type: string, listener: EventListener): void => {
        counts[type] = Math.max(0, (counts[type] ?? 0) - 1);
        target.removeEventListener(type, listener);
      };

      const ws = {
        addEventListener: addListener,
        removeEventListener: removeListener,
        send: () => {},
        close: () => {},
        accept: () => {}
      } as unknown as WebSocket;

      return {
        ws,
        listenerCount: (type) => counts[type] ?? 0,
        emitClose: (code, reason) =>
          target.dispatchEvent(
            Object.assign(new Event('close'), { code, reason }) as CloseEvent
          ),
        emitError: () => target.dispatchEvent(new Event('error'))
      };
    }

    function makeUpgradeResponseFor(ws: WebSocket): Response {
      return {
        status: 101,
        statusText: 'Switching Protocols',
        webSocket: ws
      } as unknown as Response;
    }

    it('unbinds its close and error listeners from the WebSocket on disconnect', async () => {
      const tracked = createTrackedWebSocket();
      const conn = new ContainerControlConnection({
        stub: {
          fetch: vi.fn().mockResolvedValue(makeUpgradeResponseFor(tracked.ws))
        }
      });

      await conn.connect();
      expect(tracked.listenerCount('close')).toBeGreaterThan(0);
      expect(tracked.listenerCount('error')).toBeGreaterThan(0);

      const closeBeforeDisconnect = tracked.listenerCount('close');
      const errorBeforeDisconnect = tracked.listenerCount('error');

      conn.disconnect();

      // The connection's own close/error listeners must be gone. The
      // DeferredTransport's listeners on the same WebSocket are out of
      // scope here — we only assert that the connection removed exactly
      // the listeners it added in doConnect().
      expect(tracked.listenerCount('close')).toBe(closeBeforeDisconnect - 1);
      expect(tracked.listenerCount('error')).toBe(errorBeforeDisconnect - 1);
    });

    it('does not fire onClose for a close event dispatched after disconnect()', async () => {
      const tracked = createTrackedWebSocket();
      const onClose = vi.fn();
      const conn = new ContainerControlConnection({
        stub: {
          fetch: vi.fn().mockResolvedValue(makeUpgradeResponseFor(tracked.ws))
        },
        onClose
      });

      await conn.connect();
      conn.disconnect();

      // Runtime dispatches a delayed close after we've already torn down.
      // This simulates the race where a successor connection has been
      // installed on the client and we don't want its stale predecessor's
      // close event to reach the client's onClose handler.
      tracked.emitClose(1011, 'Container WebSocket error');

      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not fire onClose for an error event dispatched after disconnect()', async () => {
      const tracked = createTrackedWebSocket();
      const onClose = vi.fn();
      const conn = new ContainerControlConnection({
        stub: {
          fetch: vi.fn().mockResolvedValue(makeUpgradeResponseFor(tracked.ws))
        },
        onClose
      });

      await conn.connect();
      conn.disconnect();

      tracked.emitError();

      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
