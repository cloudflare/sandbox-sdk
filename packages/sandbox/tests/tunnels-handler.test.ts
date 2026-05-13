/**
 * SDK tunnels handler unit tests.
 *
 * Mocks the container RPC client so we exercise the handler's validation,
 * id minting, registry, and log-event paths without standing up a real
 * container.
 */

import type { Logger, TunnelInfo } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxSecurityError } from '../src/security';
import { createTunnelsHandler } from '../src/tunnels/tunnels-handler';

function makeLogger(): Logger {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => log)
  } as unknown as Logger;
  return log;
}

interface MockTunnelsClient {
  runQuickTunnel: ReturnType<typeof vi.fn>;
  destroyTunnel: ReturnType<typeof vi.fn>;
  listTunnels: ReturnType<typeof vi.fn>;
}

function makeClient(): { client: { tunnels: MockTunnelsClient } } {
  return {
    client: {
      tunnels: {
        runQuickTunnel: vi.fn(),
        destroyTunnel: vi.fn(),
        listTunnels: vi.fn()
      }
    }
  };
}

function makeRecord(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 'quick-abcdef01',
    port: 8080,
    url: 'https://stub.trycloudflare.com',
    hostname: 'stub.trycloudflare.com',
    createdAt: '2026-05-13T00:00:00.000Z',
    ...overrides
  };
}

describe('tunnels handler > create', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('mints a `quick-<8 hex>` id and forwards it to the RPC client', async () => {
    const { client } = makeClient();
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });

    const info = await handler.create(8080);

    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
    const [id, port] = client.tunnels.runQuickTunnel.mock.calls[0];
    expect(port).toBe(8080);
    expect(id).toMatch(/^quick-[0-9a-f]{8}$/);
    expect(info.id).toBe(id);
    expect(info.name).toBeUndefined();
    expect(info.url).toBe('https://stub.trycloudflare.com');
    expect(info.hostname).toBe('stub.trycloudflare.com');
  });

  it('rejects out-of-range ports with SandboxSecurityError', async () => {
    const { client } = makeClient();
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });

    await expect(handler.create(80)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    await expect(handler.create(100000)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    await expect(handler.create(1.5)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();
  });

  it('rejects the reserved control-plane port 3000', async () => {
    const { client } = makeClient();
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });

    await expect(handler.create(3000)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();
  });
});

describe('tunnels handler > destroy', () => {
  it('forwards the id from a string argument to the RPC client', async () => {
    const { client } = makeClient();
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: 'quick-abcdef01'
    });
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });
    const info = await handler.create(8080);

    await handler.destroy(info.id);

    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(info.id);
  });

  it('accepts a TunnelInfo object and resolves the id from it', async () => {
    const { client } = makeClient();
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );
    client.tunnels.destroyTunnel.mockResolvedValue({ success: true, id: '' });
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });
    const info = await handler.create(8080);

    await handler.destroy(info);

    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(info.id);
  });

  it('propagates TUNNEL_NOT_FOUND from the RPC client', async () => {
    const { client } = makeClient();
    client.tunnels.destroyTunnel.mockRejectedValue(
      new Error('TUNNEL_NOT_FOUND: tunnel ghost is not running')
    );
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });

    await expect(handler.destroy('ghost')).rejects.toThrow(/TUNNEL_NOT_FOUND/);
  });
});

describe('tunnels handler > list', () => {
  it('returns the records as the RPC client surfaces them', async () => {
    const { client } = makeClient();
    const records: TunnelInfo[] = [
      makeRecord({ id: 'quick-aaaaaaaa', port: 8080 }),
      makeRecord({ id: 'quick-bbbbbbbb', port: 8081 })
    ];
    client.tunnels.listTunnels.mockResolvedValue(records);
    const handler = createTunnelsHandler({
      client: client as any,
      logger: makeLogger()
    });

    const tunnels = await handler.list();

    expect(tunnels).toEqual(records);
  });
});

describe('route-based SandboxClient.tunnels placeholder', () => {
  it('throws "RPC transport required" from any method on the proxy', async () => {
    // Late import so this only loads when the test runs.
    const { SandboxClient } = await import('../src/clients/sandbox-client');
    const client = new SandboxClient({ baseUrl: 'http://test.invalid' });
    expect(() =>
      (client.tunnels as unknown as { create: () => void }).create()
    ).toThrow(/RPC transport/);
    expect(() =>
      (client.tunnels as unknown as { list: () => void }).list()
    ).toThrow(/RPC transport/);
    expect(() =>
      (client.tunnels as unknown as { destroy: () => void }).destroy()
    ).toThrow(/RPC transport/);
  });
});
