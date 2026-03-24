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
  });

  describe('rpc', () => {
    it('should attempt to connect when calling rpc()', async () => {
      const conn = new ContainerConnection({
        stub: {
          fetch: vi
            .fn()
            .mockResolvedValue(new Response('Not Found', { status: 404 }))
        }
      });

      await expect(conn.rpc()).rejects.toThrow();
    });
  });

  describe('connection lifecycle with mocked internals', () => {
    it('should return connected after successful connect', async () => {
      const conn = new ContainerConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        stub: unknown;
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      const mockStub = { ping: vi.fn() };

      vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
        internals.stub = mockStub;
        internals.connected = true;
        internals.ws = { close: vi.fn() };
      });

      await conn.connect();
      expect(conn.isConnected()).toBe(true);
    });

    it('should return the stub from rpc() after connect', async () => {
      const conn = new ContainerConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        stub: unknown;
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      const mockStub = {
        ping: vi.fn().mockResolvedValue({ status: 'ok' })
      };

      vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
        internals.stub = mockStub;
        internals.connected = true;
        internals.ws = { close: vi.fn() };
      });

      const stub = await conn.rpc();
      expect(stub).toBe(mockStub);
    });

    it('should disconnect and reconnect', async () => {
      const conn = new ContainerConnection({
        stub: { fetch: vi.fn() }
      });
      const internals = conn as unknown as {
        stub: unknown;
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      const doConnect = vi
        .spyOn(internals, 'doConnect')
        .mockImplementation(async () => {
          internals.stub = { ping: vi.fn() };
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
        stub: unknown;
        connected: boolean;
        ws: unknown;
        doConnect: () => Promise<void>;
      };

      const doConnect = vi
        .spyOn(internals, 'doConnect')
        .mockImplementation(async () => {
          internals.stub = { ping: vi.fn() };
          internals.connected = true;
          internals.ws = { close: vi.fn() };
        });

      await Promise.all([conn.connect(), conn.connect()]);
      expect(doConnect).toHaveBeenCalledTimes(1);
    });
  });
});
