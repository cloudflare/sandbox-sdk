import { describe, expect, it, vi } from 'vitest';
import {
  ContainerControlConnection,
  DeferredTransport
} from '../src/container-control/connection';

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
        internals.ws = { close: vi.fn() };
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
        internals.ws = { close: vi.fn() };
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
          internals.ws = { close: vi.fn() };
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
          internals.ws = { close: vi.fn() };
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
});
