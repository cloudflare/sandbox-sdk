import { describe, expect, it, vi } from 'vitest';
import { ContainerConnection } from '../src/container-connection';

/**
 * Tests for ContainerConnection — the capnweb RPC connection manager.
 *
 * These tests verify connection lifecycle and RPC stub access.
 * The actual RPC methods are tested via E2E tests against a real container.
 */
describe('ContainerConnection', () => {
  describe('initial state', () => {
    it('should not be connected after construction', () => {
      const conn = new ContainerConnection({
        stub: { fetch: vi.fn() }
      });
      expect(conn.isConnected()).toBe(false);
    });

    it('should have a stub available immediately after construction', () => {
      const conn = new ContainerConnection({
        stub: { fetch: vi.fn() }
      });
      expect(conn.rpc()).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should be safe to call disconnect when not connected', () => {
      const conn = new ContainerConnection({
        stub: { fetch: vi.fn() }
      });
      conn.disconnect();
      expect(conn.isConnected()).toBe(false);
    });

    it('should be safe to call disconnect multiple times', () => {
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
      const conn = new ContainerConnection({
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
});
