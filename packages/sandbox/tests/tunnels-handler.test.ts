/**
 * SDK tunnels handler unit tests.
 *
 * Exercises validation, id minting, DO-storage caching, inflight
 * coalescing, and log-event paths against a mocked RPC client and a
 * lightweight in-memory `ctx.storage` shim.
 */

import type { Logger, TunnelInfo } from '@repo/shared';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxSecurityError } from '../src/security';
import {
  createTunnelsHandler,
  pruneTunnelsForRestart,
  type TunnelsHandler,
  type TunnelsStorage
} from '../src/tunnels/tunnels-handler';

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

type RunQuickTunnelMock = Mock<
  (id: string, port: number) => Promise<TunnelInfo>
>;
type DestroyTunnelMock = Mock<(id: string) => Promise<unknown>>;
type ListTunnelsMock = Mock<() => Promise<TunnelInfo[]>>;
type StorageGetMock = Mock<(key: string) => Promise<unknown>>;
type StoragePutMock = Mock<(key: string, next: unknown) => Promise<unknown>>;
type StorageTransactionMock = Mock<
  (closure: (txn: unknown) => Promise<unknown>) => Promise<unknown>
>;
type LogMock = Mock<(message: string, ...context: unknown[]) => void>;

interface MockTunnelsClient {
  runQuickTunnel: RunQuickTunnelMock;
  destroyTunnel: DestroyTunnelMock;
  listTunnels: ListTunnelsMock;
}

function makeClient(): { client: { tunnels: MockTunnelsClient } } {
  return {
    client: {
      tunnels: {
        runQuickTunnel:
          vi.fn<(id: string, port: number) => Promise<TunnelInfo>>(),
        destroyTunnel: vi.fn<(id: string) => Promise<unknown>>(),
        listTunnels: vi.fn<() => Promise<TunnelInfo[]>>()
      }
    }
  };
}

/**
 * Minimal in-memory shim covering only the storage subset the handler
 * uses. `transaction()` serializes closures via a chained promise so
 * concurrent read-modify-write callers observe a consistent map —
 * mirrors the real DO's optimistic-concurrency contract from the
 * caller's perspective.
 */
function makeStorage(initial?: Record<string, TunnelInfo>): TunnelsStorage {
  // Real DO storage is key/value; older tests only touched one key
  // ('tunnels') so the shim used a single variable. Named tunnels add a
  // sibling 'tunnels:meta' key, so the shim is now a true keyed map. The
  // legacy `initial` argument continues to seed only the 'tunnels' key.
  const data = new Map<string, unknown>();
  if (initial) data.set('tunnels', { ...initial });
  let txQueue: Promise<unknown> = Promise.resolve();
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, next: unknown) => {
      // Deep-clone-ish (JSON) so callers can't observe mutations across
      // writes. Matches the structured-clone semantics of real DO storage.
      data.set(key, JSON.parse(JSON.stringify(next)));
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    transaction: vi.fn((closure: (txn: unknown) => Promise<unknown>) => {
      const next = txQueue.then(() => closure(storage));
      // Swallow rejection on the chain so a failed closure doesn't
      // poison subsequent transactions; the original promise still
      // rejects to the caller.
      txQueue = next.catch(() => undefined);
      return next;
    })
  } as unknown as TunnelsStorage;
  return storage;
}

function makeRecord(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 'quick-0123456789abcdef',
    port: 8080,
    url: 'https://stub.trycloudflare.com',
    hostname: 'stub.trycloudflare.com',
    createdAt: '2026-05-13T00:00:00.000Z',
    ...overrides
  };
}

function makeHandler() {
  const { client } = makeClient();
  const storage = makeStorage();
  const { tunnels, handleTunnelExit } = createTunnelsHandler({
    client: client as unknown as Parameters<
      typeof createTunnelsHandler
    >[0]['client'],
    storage,
    logger: makeLogger()
  });
  // `handler` alias kept for legacy test bodies; new tests should
  // reach for `tunnels` and `handleTunnelExit` directly.
  return {
    client,
    storage,
    handler: tunnels,
    tunnels,
    handleTunnelExit
  };
}

describe('tunnels handler > get', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('mints a `quick-<8 hex>` id and forwards it to the RPC client on cache miss', async () => {
    const { client, storage, handler } = makeHandler();
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );

    const info = await handler.get(8080);

    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
    const [id, port] = client.tunnels.runQuickTunnel.mock.calls[0];
    expect(port).toBe(8080);
    expect(id).toMatch(/^quick-[0-9a-f]{8}$/);
    expect(info.id).toBe(id);
    expect(info.name).toBeUndefined();

    // Storage is written: the tunnels map under the port key, and the
    // sidecar meta map (carrying the options hash) keyed by port too.
    expect(storage.put).toHaveBeenCalledTimes(2);
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    const tunnelsPut = putCalls.find(([key]) => key === 'tunnels');
    const metaPut = putCalls.find(([key]) => key === 'tunnels:meta');
    expect(tunnelsPut?.[1]).toEqual({ '8080': info });
    expect(metaPut?.[1]).toEqual({
      '8080': { optionsHash: 'v1:quick' }
    });
  });

  it('retries with a fresh id when the container reports TUNNEL_ALREADY_RUNNING', async () => {
    // shortId() picks a 32-bit random id, so collisions are vanishingly
    // rare — but when they do happen, the container rejects the second
    // spawn with TUNNEL_ALREADY_RUNNING. Without a retry, the user-facing
    // get() call rejects with a confusing error for a transient event the
    // SDK can recover from on its own.
    const { client, handler } = makeHandler();
    let attempts = 0;
    const collision = Object.assign(
      new Error('Tunnel quick-xxxx is already running'),
      {
        code: 'TUNNEL_ALREADY_RUNNING',
        errorResponse: { code: 'TUNNEL_ALREADY_RUNNING' }
      }
    );
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => {
        attempts += 1;
        if (attempts === 1) throw collision;
        return makeRecord({ id, port });
      }
    );

    const info = await handler.get(8080);
    expect(attempts).toBe(2);
    // Two distinct ids — the retry must mint a fresh one, not reuse.
    const firstId = client.tunnels.runQuickTunnel.mock.calls[0][0];
    const secondId = client.tunnels.runQuickTunnel.mock.calls[1][0];
    expect(firstId).not.toBe(secondId);
    expect(info.id).toBe(secondId);
  });

  it('cache hit: returns the stored record without any container RPC', async () => {
    const record = makeRecord({ id: 'quick-cached0000cached', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    const info = await handler.get(8080);

    expect(info).toEqual(record);
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();
    expect(client.tunnels.listTunnels).not.toHaveBeenCalled();
    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('after storage is cleared (simulating container restart), behaves like cache miss', async () => {
    const record = makeRecord({ id: 'quick-stale00000000stale', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    // Simulate the onStart() clear.
    await storage.delete('tunnels');

    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) =>
        makeRecord({
          id,
          port,
          url: 'https://fresh.trycloudflare.com',
          hostname: 'fresh.trycloudflare.com'
        })
    );

    const info = await handler.get(8080);
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
    const [id] = client.tunnels.runQuickTunnel.mock.calls[0];
    expect(id).not.toBe(record.id); // fresh id
    expect(info.url).toBe('https://fresh.trycloudflare.com');
  });

  it('coalesces concurrent get() calls for the same port', async () => {
    const { client, handler } = makeHandler();
    let resolveRun: (info: TunnelInfo) => void = () => {};
    client.tunnels.runQuickTunnel.mockImplementation(
      (id: string, port: number) =>
        new Promise<TunnelInfo>((resolve) => {
          resolveRun = () => resolve(makeRecord({ id, port }));
        })
    );

    const a = handler.get(8080);
    const b = handler.get(8080);
    // Wait until runQuickTunnel is invoked so we know the work promise
    // is past the storage-read await and ready to resolve.
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.runQuickTunnel.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
    resolveRun(makeRecord({ id: 'ignored', port: 8080 }));
    const [resolvedA, resolvedB] = await Promise.all([a, b]);

    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
    expect(resolvedA).toEqual(resolvedB);
  });

  it('does not coalesce different ports', async () => {
    const { client, handler } = makeHandler();
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );

    const [a, b] = await Promise.all([handler.get(8080), handler.get(8081)]);
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(2);
    expect(a.port).toBe(8080);
    expect(b.port).toBe(8081);
  });

  it('writes through storage.transaction() so concurrent miss-path writes do not clobber each other', async () => {
    const { client, storage, handler } = makeHandler();
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );

    await Promise.all([handler.get(8080), handler.get(8081)]);

    // One transaction per miss-path write.
    expect(
      (storage.transaction as StorageTransactionMock).mock.calls.length
    ).toBe(2);
    // Both entries land in storage — the second writer did not clobber
    // the first.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(Object.keys(final ?? {})).toEqual(
      expect.arrayContaining(['8080', '8081'])
    );
  });

  it('clears the inflight slot when the spawn fails', async () => {
    const { client, handler } = makeHandler();
    client.tunnels.runQuickTunnel.mockRejectedValueOnce(new Error('boom'));

    await expect(handler.get(8080)).rejects.toThrow('boom');

    // Subsequent calls retry rather than re-resolving the failed promise.
    client.tunnels.runQuickTunnel.mockImplementationOnce(
      async (id: string, port: number) => makeRecord({ id, port })
    );
    const info = await handler.get(8080);
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(2);
    expect(info.port).toBe(8080);
  });

  it('rejects out-of-range ports with SandboxSecurityError', async () => {
    const { client, handler } = makeHandler();

    await expect(handler.get(80)).rejects.toBeInstanceOf(SandboxSecurityError);
    await expect(handler.get(100000)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    await expect(handler.get(1.5)).rejects.toBeInstanceOf(SandboxSecurityError);
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();
  });

  it('rejects the reserved control-plane port 3000', async () => {
    const { client, handler } = makeHandler();

    await expect(handler.get(3000)).rejects.toBeInstanceOf(
      SandboxSecurityError
    );
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();
  });
});

describe('tunnels handler > destroy', () => {
  it('clears storage and calls destroyTunnel(id) for a known port', async () => {
    const record = makeRecord({ id: 'quick-known0000known00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: record.id
    });

    await handler.destroy(8080);

    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(record.id);
    // Storage entry is removed before the RPC. Both keys (info + meta)
    // are cleared.
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    expect(putCalls).toHaveLength(2);
    const tunnelsPut = putCalls.find(([key]) => key === 'tunnels');
    const metaPut = putCalls.find(([key]) => key === 'tunnels:meta');
    expect(tunnelsPut?.[1]).toEqual({});
    expect(metaPut?.[1]).toEqual({});
  });

  it('wraps the read-modify-write in storage.transaction()', async () => {
    const record = makeRecord({ id: 'quick-tx0000tx0000tx', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: record.id
    });

    await handler.destroy(8080);

    expect(
      (storage.transaction as StorageTransactionMock).mock.calls.length
    ).toBe(1);
  });

  it('accepts a TunnelInfo object and resolves the port from it', async () => {
    const record = makeRecord({ id: 'quick-info0000info00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: record.id
    });

    await handler.destroy(record);

    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(record.id);
  });

  it('is a no-op success on unknown port', async () => {
    const { client, storage, handler } = makeHandler();

    await expect(handler.destroy(9999)).resolves.toBeUndefined();
    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('swallows TUNNEL_NOT_FOUND from the container (already gone)', async () => {
    const record = makeRecord({ id: 'quick-gone0000gone00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    // Production shape: the container emits a SandboxError carrying
    // `code: 'TUNNEL_NOT_FOUND'` in `errorResponse`. The handler must
    // match on the code, not on substring.
    const notFound = Object.assign(
      new Error('Tunnel quick-gone is not running'),
      {
        errorResponse: { code: 'TUNNEL_NOT_FOUND' },
        code: 'TUNNEL_NOT_FOUND'
      }
    );
    client.tunnels.destroyTunnel.mockRejectedValue(notFound);

    await expect(handler.destroy(8080)).resolves.toBeUndefined();
    // Storage is still cleared (both info + meta).
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    expect(putCalls).toHaveLength(2);
    expect(putCalls.find(([k]) => k === 'tunnels')?.[1]).toEqual({});
    expect(putCalls.find(([k]) => k === 'tunnels:meta')?.[1]).toEqual({});
  });

  it('does NOT swallow an unrelated error whose message merely contains the literal TUNNEL_NOT_FOUND', async () => {
    // Regression for the previous substring-match heuristic. A wrapped
    // error whose message happens to embed `TUNNEL_NOT_FOUND` (for
    // example, an upstream report quoting the original error) must
    // surface to the caller, not be silently swallowed as "already gone".
    const record = makeRecord({ id: 'quick-real0000real00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    client.tunnels.destroyTunnel.mockRejectedValue(
      new Error('rpc transport failure: original was TUNNEL_NOT_FOUND')
    );

    await expect(handler.destroy(8080)).rejects.toThrow(
      /rpc transport failure/
    );
  });

  it('does not roll back storage when the container call fails with a non-NOT_FOUND error', async () => {
    const record = makeRecord({ id: 'quick-err000000err000', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    client.tunnels.destroyTunnel.mockRejectedValue(new Error('boom'));

    await expect(handler.destroy(8080)).rejects.toThrow('boom');
    const putCalls = (storage.put as StoragePutMock).mock.calls;
    // Storage was cleared before the RPC and is not restored on failure.
    expect(putCalls).toHaveLength(2);
    expect(putCalls.find(([k]) => k === 'tunnels')?.[1]).toEqual({});
    expect(putCalls.find(([k]) => k === 'tunnels:meta')?.[1]).toEqual({});
  });
});

describe('tunnels handler > list', () => {
  it('returns the values from storage (no container round-trip)', async () => {
    const a = makeRecord({ id: 'quick-aaaa1111aaaa1111', port: 8080 });
    const b = makeRecord({
      id: 'quick-bbbb2222bbbb2222',
      port: 8081,
      url: 'https://b.trycloudflare.com',
      hostname: 'b.trycloudflare.com'
    });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': a, '8081': b });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    const tunnels = await handler.list();
    expect(tunnels).toEqual(expect.arrayContaining([a, b]));
    expect(tunnels).toHaveLength(2);
    expect(client.tunnels.listTunnels).not.toHaveBeenCalled();
  });

  it('returns an empty array when storage is empty', async () => {
    const { handler } = makeHandler();
    await expect(handler.list()).resolves.toEqual([]);
  });
});

describe('tunnels handler > per-port serialization', () => {
  it('queues destroy(port) behind an in-flight get(port) so the destroy sees the new record', async () => {
    const { client, storage, handler } = makeHandler();
    let resolveSpawn: (info: TunnelInfo) => void = () => {};
    client.tunnels.runQuickTunnel.mockImplementation(
      (id: string, port: number) =>
        new Promise<TunnelInfo>((resolve) => {
          resolveSpawn = () => resolve(makeRecord({ id, port }));
        })
    );
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: ''
    });

    // Kick off get() but don't await yet — it's blocked on runQuickTunnel.
    const getPromise = handler.get(8080);
    // Wait until the spawn is in flight so we know get() holds the lock.
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.runQuickTunnel.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);

    // Now race a destroy(8080) against the unfinished get(). Without
    // serialization, the destroy would observe an empty map and return
    // a no-op success, then get() would write its record into storage
    // — leaking a cloudflared process the user thinks is gone.
    const destroyPromise = handler.destroy(8080);
    // Give the destroy a tick to attempt entering the critical section.
    await new Promise((r) => setTimeout(r, 5));
    // The destroy must NOT have called destroyTunnel yet (no record to destroy).
    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();

    // Let get() complete.
    resolveSpawn(makeRecord({ id: 'unused', port: 8080 }));
    const info = await getPromise;
    await destroyPromise;

    // The destroy ran *after* the get wrote, so it tore down the right tunnel.
    expect(client.tunnels.destroyTunnel).toHaveBeenCalledTimes(1);
    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(info.id);
    // Storage is empty at the end — the get's write and the destroy's
    // clear both happened, in that order.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final ?? {}).toEqual({});
  });

  it('queues get(port) behind an in-flight destroy(port)', async () => {
    const record = makeRecord({ id: 'quick-pre000pre000pre0', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels: handler } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });
    let resolveDestroy: () => void = () => {};
    client.tunnels.destroyTunnel.mockImplementation(
      () =>
        new Promise<{ success: true; id: string }>((resolve) => {
          resolveDestroy = () => resolve({ success: true, id: record.id });
        })
    );
    client.tunnels.runQuickTunnel.mockImplementation(
      async (id: string, port: number) => makeRecord({ id, port })
    );

    const destroyPromise = handler.destroy(8080);
    // Wait until the destroy is in flight (has called destroyTunnel).
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.destroyTunnel.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(client.tunnels.destroyTunnel).toHaveBeenCalledTimes(1);

    // get() must wait — if it ran now it would see the empty map and
    // try to spawn while destroy() is still tearing down the old one.
    const getPromise = handler.get(8080);
    await new Promise((r) => setTimeout(r, 5));
    expect(client.tunnels.runQuickTunnel).not.toHaveBeenCalled();

    resolveDestroy();
    await destroyPromise;
    const info = await getPromise;

    // After the destroy completes, get() spawned a fresh tunnel — not
    // resurrected the old record.
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
    expect(info.id).not.toBe(record.id);
  });
});

describe('tunnels handler > handleTunnelExit', () => {
  it('clears the matching port from storage when the stored id matches', async () => {
    const record = makeRecord({ id: 'quick-exit0000exit0000', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': record });
    const { tunnels, handleTunnelExit } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit(record.id, 8080, 0);

    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final ?? {}).toEqual({});
    // No container RPCs were issued — the exit hook is pure storage.
    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();
    // `tunnels.list()` reflects the cleared storage.
    await expect(tunnels.list()).resolves.toEqual([]);
  });

  it('preserves named-tunnel meta and marks needsRespawn on unsolicited exit', async () => {
    // Quick tunnels can be wiped outright: the *.trycloudflare.com URL
    // dies with cloudflared. Named tunnels are different — the CF-side
    // tunnel and DNS record are still live, and the SDK needs `dnsRecordId`
    // (plus `accountId`/`zoneId` for the drift-aware destroy path) to
    // clean them up later. So mirror `pruneTunnelsForRestart`: keep the
    // record + meta, mark `needsRespawn: true`. The next get(port, { name })
    // takes the existing reuse path and respawns cloudflared.
    const record: TunnelInfo = {
      id: 'tunnel-uuid-named',
      port: 8080,
      name: 'api',
      hostname: 'api.example.com',
      url: 'https://api.example.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    };
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': record
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'kept-dns-id',
        accountId: 'acct-A',
        zoneId: 'zone-A'
      }
    });
    const { handleTunnelExit } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await handleTunnelExit('tunnel-uuid-named', 8080, 0);

    // The tunnel record is left in place so list() still surfaces the
    // (now-detached) hostname — the next get() will respawn cloudflared.
    const tunnels = (await storage.get<Record<string, TunnelInfo>>(
      'tunnels'
    )) as Record<string, TunnelInfo>;
    expect(tunnels['8080']).toBeDefined();
    expect(tunnels['8080'].id).toBe('tunnel-uuid-named');

    // Meta is preserved verbatim, with `needsRespawn` flipped on so the
    // next get(port, { name }) cache hit falls through to provision.
    const meta = (await storage.get<
      Record<
        string,
        {
          optionsHash: string;
          dnsRecordId?: string;
          accountId?: string;
          zoneId?: string;
          needsRespawn?: boolean;
        }
      >
    >('tunnels:meta')) as Record<
      string,
      {
        optionsHash: string;
        dnsRecordId?: string;
        accountId?: string;
        zoneId?: string;
        needsRespawn?: boolean;
      }
    >;
    expect(meta['8080']?.dnsRecordId).toBe('kept-dns-id');
    expect(meta['8080']?.accountId).toBe('acct-A');
    expect(meta['8080']?.zoneId).toBe('zone-A');
    expect(meta['8080']?.needsRespawn).toBe(true);
  });

  it('is a no-op when the stored id has been replaced (id-mismatch safety net)', async () => {
    const newer = makeRecord({ id: 'quick-newer000newer00', port: 8080 });
    const { client } = makeClient();
    const storage = makeStorage({ '8080': newer });
    const { handleTunnelExit } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    // Callback fires for an OLDER tunnel id that's no longer in storage.
    await handleTunnelExit('quick-stale0000stale00', 8080, null);

    // Storage is untouched.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final).toEqual({ '8080': newer });
  });

  it('is a no-op when storage is empty (already destroyed)', async () => {
    const { client } = makeClient();
    const storage = makeStorage();
    const { handleTunnelExit } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger()
    });

    await expect(
      handleTunnelExit('quick-anything00000ok', 8080, null)
    ).resolves.toBeUndefined();
    // No write happened.
    expect((storage.put as StoragePutMock).mock.calls.length).toBe(0);
  });

  it('runs under the port lock — waits for a concurrent get(port) to complete', async () => {
    const { client, storage, tunnels, handleTunnelExit } = makeHandler();
    let resolveSpawn: (info: TunnelInfo) => void = () => {};
    client.tunnels.runQuickTunnel.mockImplementation(
      (id: string, port: number) =>
        new Promise<TunnelInfo>((resolve) => {
          resolveSpawn = () => resolve(makeRecord({ id, port }));
        })
    );

    // Kick off a slow get(8080). Holds the port lock past the spawn.
    const getPromise = tunnels.get(8080);
    for (let i = 0; i < 50; i++) {
      if (client.tunnels.runQuickTunnel.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }

    // Fire an exit callback for some arbitrary id while get() is
    // blocked. Without the lock, the callback would read the empty
    // storage now (before get() writes) and observe nothing to clean
    // up. With the lock, it must wait until get() releases.
    const exitPromise = handleTunnelExit('quick-old', 8080, 0);
    await new Promise((r) => setTimeout(r, 5));

    // The exit hook has not yet read storage — storage is empty so
    // there's nothing visible to assert directly, but we *can* assert
    // it hasn't completed.
    let exitResolved = false;
    void exitPromise.then(() => {
      exitResolved = true;
    });
    expect(exitResolved).toBe(false);

    // Let get() finish.
    resolveSpawn(makeRecord({ id: 'unused', port: 8080 }));
    const info = await getPromise;
    await exitPromise;

    // The exit callback ran after the get() wrote storage, saw a
    // different id ('quick-old' vs the spawned id), and no-op'd —
    // the spawned record is still there.
    const final = await storage.get<Record<string, TunnelInfo>>('tunnels');
    expect(final).toEqual({ '8080': info });
  });

  it('logs an error canonical event when the storage transaction throws', async () => {
    // Inject a storage shim whose transaction() rejects. Without proper
    // try/catch around the canonical-log emit, the failure would escape
    // the port-lock chain unobserved and no event would be logged.
    const logger = makeLogger();
    const failingStorage = {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn().mockRejectedValue(new Error('boom'))
    } as unknown as TunnelsStorage;
    const { client } = makeClient();
    const { handleTunnelExit } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage: failingStorage,
      logger
    });

    // The handler must surface the rejection to the caller so the
    // port-lock chain and any awaiter see it — silently swallowing
    // would hide the bug.
    await expect(handleTunnelExit('quick-x', 8080, 0)).rejects.toThrow(/boom/);

    // And a canonical event with outcome: 'error' must have been logged.
    const errorCalls = (logger.error as LogMock).mock.calls;
    const eventCall = errorCalls.find(([msg]) =>
      String(msg).includes('tunnel.exit')
    );
    expect(eventCall).toBeDefined();
  });
});

describe('TunnelsHandler public surface', () => {
  it('does not expose any exit hook on the public interface', () => {
    // Compile-time guard: if a future change adds a method to
    // TunnelsHandler beyond get/list/destroy, this assertion fails
    // and the developer has to consciously update the allowlist.
    type AllowedKeys = 'get' | 'list' | 'destroy';
    type _Check = keyof TunnelsHandler extends AllowedKeys ? true : false;
    const ok: _Check = true;
    expect(ok).toBe(true);
  });
});

describe('pruneTunnelsForRestart', () => {
  it('drops quick-tunnel entries and marks named ones for respawn', async () => {
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: 'quick-abc',
        port: 8080,
        url: 'https://x.trycloudflare.com',
        hostname: 'x.trycloudflare.com',
        createdAt: '2024-01-01T00:00:00.000Z'
      },
      '8081': {
        id: 'uuid-1',
        port: 8081,
        name: 'app',
        hostname: 'app.example.com',
        url: 'https://app.example.com',
        createdAt: '2024-01-01T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': { optionsHash: 'quick' },
      '8081': { optionsHash: 'named:app', dnsRecordId: 'rec-1' }
    });

    await pruneTunnelsForRestart(storage);

    const nextTunnels = (await (storage.get as StorageGetMock)(
      'tunnels'
    )) as Record<string, { name?: string }>;
    const nextMeta = (await (storage.get as StorageGetMock)(
      'tunnels:meta'
    )) as Record<string, { needsRespawn?: boolean; dnsRecordId?: string }>;
    expect(Object.keys(nextTunnels)).toEqual(['8081']);
    expect(nextMeta['8081']?.needsRespawn).toBe(true);
    // dnsRecordId is preserved so destroy() can still clean up.
    expect(nextMeta['8081']?.dnsRecordId).toBe('rec-1');
    expect(nextMeta['8080']).toBeUndefined();
  });

  it('is a no-op on empty storage', async () => {
    const storage = makeStorage();
    await pruneTunnelsForRestart(storage);
    const nextTunnels = (await (storage.get as StorageGetMock)(
      'tunnels'
    )) as Record<string, unknown>;
    expect(nextTunnels).toEqual({});
  });
});
