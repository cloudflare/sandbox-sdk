/**
 * Named-tunnel behavior tests for the SDK tunnels handler.
 *
 * Sibling to `tunnels-handler.test.ts` (which covers the quick-tunnel
 * surface). This file exercises:
 *   - the `get(port, { name })` flow end-to-end (tag/DNS/run/store)
 *   - options-hash idempotency and the divergence guard
 *   - retry reuse via tagged-resource lookup
 *   - destroy() cleanup of the Cloudflare-side resources
 *   - synchronous validation failures (name format, missing creds)
 *
 * Cloudflare API calls are mocked via `fetcher`; container RPC is the
 * same `MockTunnelsClient` shape used by the quick-tunnel tests. The
 * storage shim is the keyed one defined here.
 */

import type { Logger, TunnelInfo } from '@repo/shared';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeIdentityInactiveError } from '../src/current-runtime-identity';
import { ErrorCode } from '../src/errors';
import { SandboxSecurityError } from '../src/security';
import {
  createTunnelsHandler,
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
type RunNamedTunnelMock = Mock<
  (id: string, token: string, port: number) => Promise<unknown>
>;
type DestroyTunnelMock = Mock<(id: string) => Promise<unknown>>;
type ListTunnelsMock = Mock<() => Promise<TunnelInfo[]>>;
type FetcherMock = Mock<
  (input: string | URL, init?: RequestInit) => Promise<Response>
>;
type StorageGetMock = Mock<(key: string) => Promise<unknown>>;
type StoragePutMock = Mock<(key: string, next: unknown) => Promise<unknown>>;
type LogMock = Mock<(message: string, ...context: unknown[]) => void>;

interface MockTunnelsClient {
  runQuickTunnel: RunQuickTunnelMock;
  runNamedTunnel: RunNamedTunnelMock;
  destroyTunnel: DestroyTunnelMock;
  listTunnels: ListTunnelsMock;
}

function makeClient(): { client: { tunnels: MockTunnelsClient } } {
  return {
    client: {
      tunnels: {
        runQuickTunnel:
          vi.fn<(id: string, port: number) => Promise<TunnelInfo>>(),
        runNamedTunnel:
          vi.fn<
            (id: string, token: string, port: number) => Promise<unknown>
          >(),
        destroyTunnel: vi.fn<(id: string) => Promise<unknown>>(),
        listTunnels: vi.fn<() => Promise<TunnelInfo[]>>()
      }
    }
  };
}

function makeStorage(): TunnelsStorage {
  const data = new Map<string, unknown>();
  let txQueue: Promise<unknown> = Promise.resolve();
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, next: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(next)));
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    transaction: vi.fn((closure: (txn: unknown) => Promise<unknown>) => {
      const next = txQueue.then(() => closure(storage));
      txQueue = next.catch(() => undefined);
      return next;
    })
  } as unknown as TunnelsStorage;
  return storage;
}

interface FakeCloudflare {
  fetcher: FetcherMock;
  /** Map of `<METHOD> <url>` → handler. */
  routes: Map<string, (init: RequestInit) => Promise<Response> | Response>;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function makeFakeCloudflare(opts: {
  zoneName?: string;
  existingTunnels?: Array<{
    id: string;
    name: string;
    deleted_at?: string | null;
    metadata?: unknown;
  }>;
  existingDns?: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    comment?: string | null;
  }>;
  createdTunnel?: { id: string; token: string };
  createdDnsId?: string;
}): FakeCloudflare {
  const zoneName = opts.zoneName ?? 'example.com';
  const createdTunnel = opts.createdTunnel ?? {
    id: '11111111-2222-3333-4444-555555555555',
    token: 'OPAQUE_TOKEN'
  };
  const createdDnsId = opts.createdDnsId ?? 'dns-id';
  const existingTunnels = opts.existingTunnels ?? [];
  const existingDns = opts.existingDns ?? [];

  const routes = new Map<
    string,
    (init: RequestInit) => Promise<Response> | Response
  >();

  const fetcher = vi.fn<
    (input: string | URL, init?: RequestInit) => Promise<Response>
  >(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    // Zone lookup.
    if (method === 'GET' && /\/zones\/[^/]+$/.test(new URL(url).pathname)) {
      return jsonOk({ id: 'zone-id', name: zoneName });
    }

    // List tunnels by name.
    if (method === 'GET' && new URL(url).pathname.endsWith('/cfd_tunnel')) {
      const u = new URL(url);
      const wantedName = u.searchParams.get('name');
      const matches = existingTunnels.filter((t) => t.name === wantedName);
      return jsonOk(matches);
    }

    // Create tunnel.
    if (method === 'POST' && new URL(url).pathname.endsWith('/cfd_tunnel')) {
      return jsonOk(createdTunnel);
    }

    // Get tunnel token (reuse path).
    if (
      method === 'GET' &&
      /\/cfd_tunnel\/[^/]+\/token$/.test(new URL(url).pathname)
    ) {
      return jsonOk('REUSED_TOKEN');
    }

    // Delete tunnel.
    if (
      method === 'DELETE' &&
      /\/cfd_tunnel\/[^/]+$/.test(new URL(url).pathname)
    ) {
      return jsonOk({ id: 'deleted' });
    }

    // List DNS records.
    if (method === 'GET' && new URL(url).pathname.endsWith('/dns_records')) {
      const u = new URL(url);
      const wanted = u.searchParams.get('name');
      const matches = existingDns.filter((r) => r.name === wanted);
      return jsonOk(matches);
    }

    // Create DNS record.
    if (method === 'POST' && new URL(url).pathname.endsWith('/dns_records')) {
      return jsonOk({ id: createdDnsId });
    }

    // Delete DNS record.
    if (
      method === 'DELETE' &&
      /\/dns_records\/[^/]+$/.test(new URL(url).pathname)
    ) {
      return jsonOk({ id: 'deleted' });
    }

    return new Response(JSON.stringify({ success: false, errors: [] }), {
      status: 500
    });
  });
  return { fetcher, routes };
}

type TunnelsHost = Parameters<typeof createTunnelsHandler>[0];

/** Tunnel UUID the container returns from `runNamedTunnel` in these tests. */
const NAMED_TUNNEL_ID = '11111111-2222-3333-4444-555555555555';

/** Stub the container's named-tunnel spawn with the canonical wire shape. */
function mockNamedSpawn(
  client: { tunnels: MockTunnelsClient },
  port = 8080
): void {
  client.tunnels.runNamedTunnel.mockResolvedValue({
    id: NAMED_TUNNEL_ID,
    port,
    url: '',
    hostname: '',
    createdAt: '2026-05-13T00:00:00.000Z'
  });
}

/**
 * Pass-through runtime/lifetime fences. Both default to a single stable
 * identity that always asserts active; tests override only the hook whose
 * behavior they exercise.
 */
function makeFences(
  overrides: {
    currentRuntime?: Record<string, unknown>;
    currentLifetime?: Record<string, unknown>;
  } = {}
): Pick<TunnelsHost, 'currentRuntime' | 'currentLifetime'> {
  return {
    currentRuntime: {
      get: vi.fn(async () => ({ id: 'runtime-1' })),
      markStarted: vi.fn(async () => ({ id: 'runtime-1' })),
      assertActive: vi.fn(async () => {}),
      ...overrides.currentRuntime
    },
    currentLifetime: {
      getOrCreate: vi.fn(async () => ({ id: 'lifetime-1' })),
      assertCurrent: vi.fn(async () => {}),
      ...overrides.currentLifetime
    }
  } as unknown as Pick<TunnelsHost, 'currentRuntime' | 'currentLifetime'>;
}

function makeHandler(opts?: {
  sandboxId?: string;
  fetcher?: typeof fetch;
  config?: Partial<{
    token: string;
    accountId: string;
    zoneId: string;
  }>;
  configError?: Error;
  fences?: Pick<TunnelsHost, 'currentRuntime' | 'currentLifetime'>;
}) {
  const { client } = makeClient();
  const storage = makeStorage();
  const logger = makeLogger();
  const namedTunnelConfig = {
    token: opts?.config?.token ?? 'TOK',
    accountId: opts?.config?.accountId ?? 'ACCT',
    zoneId: opts?.config?.zoneId ?? 'zone-id'
  };
  const built = createTunnelsHandler({
    client: client as unknown as TunnelsHost['client'],
    storage,
    logger,
    sandboxId: opts?.sandboxId ?? 'sb1',
    getNamedTunnelConfig: opts?.configError
      ? async () => {
          throw opts.configError as Error;
        }
      : async () => namedTunnelConfig,
    fetcher: opts?.fetcher,
    ...opts?.fences
  } as unknown as TunnelsHost);
  return {
    client,
    storage,
    logger,
    tunnels: built.tunnels,
    handleTunnelExit: built.handleTunnelExit,
    destroyAll: built.destroyAll,
    resumeCleanup: built.resumeCleanup
  };
}

describe('tunnels handler > get(port, { name }) — named tunnel happy path', () => {
  it('provisions a fresh named tunnel end-to-end', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    const info = await tunnels.get(8080, { name: 'api' });

    expect(info.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(info.port).toBe(8080);
    expect(info.name).toBe('api');
    expect(info.hostname).toBe('api.example.com');
    expect(info.url).toBe('https://api.example.com');
    expect(typeof info.createdAt).toBe('string');

    // runNamedTunnel was called with the opaque token from the create
    // response. The token must not leak into the returned info.
    expect(client.tunnels.runNamedTunnel).toHaveBeenCalledTimes(1);
    const [, token, port] = client.tunnels.runNamedTunnel.mock.calls[0];
    expect(token).toBe('OPAQUE_TOKEN');
    expect(port).toBe(8080);
    expect(JSON.stringify(info)).not.toContain('OPAQUE_TOKEN');
  });

  it('bounds runtime-replacement recovery and never commits a partial record', async () => {
    // Every post-spawn fence reports a replaced runtime, so recovery can
    // never converge. The operation surfaces recovery_exhausted and
    // leaves storage empty so no orphaned tunnel record persists.
    const cf = makeFakeCloudflare({});
    let assertCalls = 0;
    const { client, storage, tunnels } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch,
      fences: makeFences({
        currentRuntime: {
          assertActive: vi.fn(async () => {
            assertCalls += 1;
            if (assertCalls % 2 === 0) {
              throw new RuntimeIdentityInactiveError();
            }
          })
        }
      })
    });
    mockNamedSpawn(client);

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toMatchObject({
      name: 'OperationInterruptedError',
      code: ErrorCode.OPERATION_INTERRUPTED,
      context: expect.objectContaining({
        reason: 'recovery_exhausted',
        operation: 'tunnel.get',
        retryable: true,
        admitted: true,
        recoveryAttempts: 2,
        maxRecoveryAttempts: 2
      })
    });
    expect(await storage.get('tunnels')).toBeUndefined();
    expect(await storage.get('tunnels:meta')).toBeUndefined();
  });

  it('records runtime, lifetime, and named identity metadata', async () => {
    const cf = makeFakeCloudflare({});
    const { client, storage, tunnels } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch,
      fences: makeFences()
    });
    mockNamedSpawn(client);

    await tunnels.get(8080, { name: 'api' });

    const meta =
      await storage.get<Record<string, Record<string, unknown>>>(
        'tunnels:meta'
      );
    expect(meta?.['8080']).toMatchObject({
      runtimeIdentityID: 'runtime-1',
      sandboxLifetimeID: 'lifetime-1',
      tunnelId: NAMED_TUNNEL_ID,
      name: 'api',
      hostname: 'api.example.com'
    });
  });

  it('tags the tunnel with sandboxId/createdBy/name/port', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb-xyz',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 9090,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    await tunnels.get(9090, { name: 'web' });

    // The POST /cfd_tunnel call carries the metadata.
    const createCall = cf.fetcher.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/cfd_tunnel') &&
        (init as RequestInit)?.method === 'POST'
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body.name).toBe('sandbox-sb-xyz-web');
    expect(body.config_src).toBe('cloudflare');
    expect(body.metadata).toEqual({
      sandboxId: 'sb-xyz',
      createdBy: 'sandbox-sdk',
      name: 'web',
      port: 9090
    });
  });

  it('creates a proxied CNAME with sandbox-<id> comment', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb-dns',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    await tunnels.get(8080, { name: 'api' });

    const dnsCreate = cf.fetcher.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/dns_records') &&
        (init as RequestInit)?.method === 'POST'
    );
    expect(dnsCreate).toBeDefined();
    const body = JSON.parse(String((dnsCreate![1] as RequestInit).body));
    expect(body.type).toBe('CNAME');
    expect(body.name).toBe('api.example.com');
    expect(body.content).toBe(
      '11111111-2222-3333-4444-555555555555.cfargotunnel.com'
    );
    expect(body.proxied).toBe(true);
    expect(body.comment).toBe('sandbox-sb-dns');
  });
});

describe('tunnels handler > get(port, options) — idempotency / hash guard', () => {
  it('returns the cached record on identical second call (no work performed)', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    const first = await tunnels.get(8080, { name: 'api' });
    cf.fetcher.mockClear();
    client.tunnels.runNamedTunnel.mockClear();

    const second = await tunnels.get(8080, { name: 'api' });
    expect(second).toEqual(first);
    // No CF API calls, no container RPC.
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
  });

  it('quick → named on same port throws', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runQuickTunnel.mockResolvedValue({
      id: 'quick-abcd1234',
      port: 8080,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    await tunnels.get(8080);

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /destroy/i
    );
  });

  it('named → named with different name on same port throws', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    await tunnels.get(8080, { name: 'api' });
    await expect(tunnels.get(8080, { name: 'web' })).rejects.toThrow(
      /destroy/i
    );
  });

  it('re-provisions when CLOUDFLARE_ZONE_ID changes between calls (no stale URL)', async () => {
    // First call resolves zoneId='zone-old' (zone name example-old.com).
    // Then the resolver flips to zoneId='zone-new' (zone name
    // example-new.com), simulating a Worker redeploy with a different
    // CLOUDFLARE_ZONE_ID. The next get(port, { name }) must NOT return
    // the cached info pointing at the old zone — the URL would resolve
    // to nothing live. It must re-provision against the new zone.
    const { client } = makeClient();
    const storage = makeStorage();
    const logger = makeLogger();
    let zoneState = { zoneId: 'zone-old', zoneName: 'example-old.com' };
    const fetcher = vi.fn<
      (input: string | URL, init?: RequestInit) => Promise<Response>
    >(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith(`/zones/${zoneState.zoneId}`)) {
        return jsonOk({ id: zoneState.zoneId, name: zoneState.zoneName });
      }
      if (method === 'GET' && url.includes('/cfd_tunnel?name=')) {
        return jsonOk([]);
      }
      if (method === 'POST' && url.endsWith('/cfd_tunnel')) {
        return jsonOk({
          id: `tun-${zoneState.zoneId}`,
          token: 'OPAQUE'
        });
      }
      if (method === 'GET' && url.includes('/dns_records?')) {
        return jsonOk([]);
      }
      if (method === 'POST' && url.includes('/dns_records')) {
        return jsonOk({ id: `dns-${zoneState.zoneId}` });
      }
      throw new Error(`Unhandled ${method} ${url}`);
    });
    const built = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger,
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => ({
        token: 'TOK',
        accountId: 'ACCT',
        zoneId: zoneState.zoneId
      }),
      fetcher: fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockImplementation(async (id: string) => ({
      id,
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    }));

    const first = await built.tunnels.get(8080, { name: 'api' });
    expect(first.hostname).toBe('api.example-old.com');

    // Flip the zone behind the resolver's back.
    zoneState = { zoneId: 'zone-new', zoneName: 'example-new.com' };

    const second = await built.tunnels.get(8080, { name: 'api' });
    expect(second.hostname).toBe('api.example-new.com');
    expect(second.id).toBe('tun-zone-new');
  });

  it('get(port) and get(port, {}) hash to the same key', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runQuickTunnel.mockResolvedValue({
      id: 'quick-abcd1234',
      port: 8080,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    const a = await tunnels.get(8080);
    const b = await tunnels.get(8080, {});
    expect(b).toEqual(a);
    // Only one container call.
    expect(client.tunnels.runQuickTunnel).toHaveBeenCalledTimes(1);
  });

  it('treats legacy unversioned hashes as equivalent to v1: hashes on cache hit', async () => {
    // Forward compat: an existing deploy may have stored optionsHash
    // 'quick' or 'named:foo' (no version prefix). After the format
    // bumps to 'v1:quick' / 'v1:named:foo', the cache-hit comparison
    // must treat the two as the same to avoid flipping every live
    // tunnel into the "different options" error path on upgrade.
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    // Seed storage with a legacy (unversioned) named-tunnel record.
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: '11111111-2222-3333-4444-555555555555',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        url: 'https://api.example.com',
        createdAt: '2026-05-01T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'named:api',
        dnsRecordId: 'kept-dns-id',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }
    });

    const info = await tunnels.get(8080, { name: 'api' });
    expect(info.hostname).toBe('api.example.com');
    // Cache hit: no container call, no CF API calls.
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });
});

describe('tunnels handler > get(port, { name }) — retry / reuse', () => {
  it('reuses a tunnel left behind from a previous failed attempt', async () => {
    const cf = makeFakeCloudflare({
      existingTunnels: [
        {
          id: 'reused-tun-id',
          name: 'sandbox-sb1-api',
          deleted_at: null,
          metadata: { sandboxId: 'sb1', createdBy: 'sandbox-sdk' }
        }
      ]
    });
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: 'reused-tun-id',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    const info = await tunnels.get(8080, { name: 'api' });
    expect(info.id).toBe('reused-tun-id');

    // No POST /cfd_tunnel — the existing tagged tunnel was reused.
    const createTunnelCall = cf.fetcher.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/cfd_tunnel') &&
        (init as RequestInit)?.method === 'POST'
    );
    expect(createTunnelCall).toBeUndefined();
  });

  it('resumes retained cleanup before provisioning the same port', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await storage.put('tunnels:cleanup', {
      '8080': {
        tunnelId: 'tunnel-uuid-retained',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'dns-record-retained',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'claimed',
        updatedAt: '2026-05-13T00:00:00.000Z'
      }
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    await tunnels.get(8080, { name: 'api' });

    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(
      targets.some((t) => t.includes('/dns_records/dns-record-retained'))
    ).toBe(true);
    expect(
      targets.some((t) => t.includes('/cfd_tunnel/tunnel-uuid-retained'))
    ).toBe(true);
    expect(await storage.get('tunnels:cleanup')).toEqual({});
  });

  it('throws when a DNS record exists pointing at different content', async () => {
    const cf = makeFakeCloudflare({
      existingDns: [
        {
          id: 'foreign-dns',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'someone-else.cfargotunnel.com',
          comment: 'not-ours'
        }
      ]
    });
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /already exists|owned/i
    );
    // Container was never told to spawn cloudflared.
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
  });

  it('leaves CF resources in place when cloudflared fails to become ready', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockRejectedValue(
      new Error('cloudflared not ready')
    );

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /not ready/
    );

    // No DELETE was issued for the tunnel or the DNS record.
    const deleteCalls = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit)?.method === 'DELETE'
    );
    expect(deleteCalls).toEqual([]);

    // Storage was not written.
    const tunnels1 = (await (storage.get as StorageGetMock)(
      'tunnels'
    )) as unknown;
    expect(tunnels1 ?? {}).toEqual({});
  });
});

describe('tunnels handler > restart respawn via needsRespawn flag', () => {
  it('respawns a named cache hit owned by an old runtime', async () => {
    const cf = makeFakeCloudflare({
      existingTunnels: [
        {
          id: 'kept-tun-id',
          name: 'sandbox-sb1-api',
          deleted_at: null,
          metadata: { sandboxId: 'sb1', createdBy: 'sandbox-sdk' }
        }
      ],
      existingDns: [
        {
          id: 'kept-dns-id',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'kept-tun-id.cfargotunnel.com',
          comment: 'sandbox-sb1'
        }
      ]
    });
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: 'kept-tun-id',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        url: 'https://api.example.com',
        createdAt: '2026-05-01T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'kept-dns-id',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        runtimeIdentityID: 'runtime-old',
        sandboxLifetimeID: 'lifetime-1'
      }
    });
    const { tunnels } = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger(),
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => ({
        token: 'TOK',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }),
      fetcher: cf.fetcher as unknown as typeof fetch,
      currentRuntime: {
        get: vi.fn(async () => ({ id: 'runtime-new' })),
        markStarted: vi.fn(async () => ({ id: 'runtime-new' })),
        assertActive: vi.fn(async () => {})
      },
      currentLifetime: {
        getOrCreate: vi.fn(async () => ({ id: 'lifetime-1' })),
        assertCurrent: vi.fn(async () => {})
      }
    } as unknown as Parameters<typeof createTunnelsHandler>[0]);
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: 'kept-tun-id',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    const info = await tunnels.get(8080, { name: 'api' });

    expect(info.id).toBe('kept-tun-id');
    expect(info.hostname).toBe('api.example.com');
    expect(client.tunnels.runNamedTunnel).toHaveBeenCalledWith(
      'kept-tun-id',
      'REUSED_TOKEN',
      8080
    );
  });

  it('rejects different named-tunnel options while hidden respawn state exists', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await (storage.put as StoragePutMock)('tunnels', {});
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        tunnelId: 'kept-tun-id',
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'kept-dns-id',
        needsRespawn: true
      }
    });

    await expect(tunnels.get(8080, { name: 'web' })).rejects.toThrow(
      /destroy/i
    );
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });

  it('respawns cloudflared and reuses the CF tunnel + DNS on cache hit when needsRespawn is set', async () => {
    // Simulate the post-restart state: the tunnel + meta entries are
    // still in storage (because pruneTunnelsForRestart kept them) with
    // `needsRespawn: true` on the meta entry. The CF-side tunnel is
    // discoverable by name and the DNS record matches what we'd upsert.
    const cf = makeFakeCloudflare({
      existingTunnels: [
        {
          id: 'kept-tun-id',
          name: 'sandbox-sb1-api',
          deleted_at: null,
          metadata: { sandboxId: 'sb1', createdBy: 'sandbox-sdk' }
        }
      ],
      existingDns: [
        {
          id: 'kept-dns-id',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'kept-tun-id.cfargotunnel.com',
          comment: 'sandbox-sb1'
        }
      ]
    });
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    // Seed storage as pruneTunnelsForRestart would leave it.
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: 'kept-tun-id',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        url: 'https://api.example.com',
        createdAt: '2026-05-01T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'named:api',
        dnsRecordId: 'kept-dns-id',
        needsRespawn: true
      }
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: 'kept-tun-id',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    const info = await tunnels.get(8080, { name: 'api' });

    // cloudflared was respawned with the reused tunnel id.
    expect(client.tunnels.runNamedTunnel).toHaveBeenCalledTimes(1);
    expect(info.id).toBe('kept-tun-id');
    expect(info.hostname).toBe('api.example.com');
    // No POST /cfd_tunnel — reuse path only.
    const createTunnelCall = cf.fetcher.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/cfd_tunnel') &&
        (init as RequestInit)?.method === 'POST'
    );
    expect(createTunnelCall).toBeUndefined();
    // The fresh meta write clears `needsRespawn`.
    const meta = (await (storage.get as StorageGetMock)(
      'tunnels:meta'
    )) as Record<string, { needsRespawn?: boolean }>;
    expect(meta['8080']?.needsRespawn).toBeUndefined();
  });
});

describe('tunnels handler > get(port, { name }) — synchronous validation', () => {
  it('rejects invalid name format without any work', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(
      tunnels.get(8080, { name: 'BAD.NAME' })
    ).rejects.toBeInstanceOf(SandboxSecurityError);
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
  });

  it('rejects invalid port without any work', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(tunnels.get(3000, { name: 'api' })).rejects.toThrow(/port/i);
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
  });

  it('propagates the credentials resolver error verbatim', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      configError: new Error('Missing CLOUDFLARE_API_TOKEN'),
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /CLOUDFLARE_API_TOKEN/
    );
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.runNamedTunnel).not.toHaveBeenCalled();
  });
});

describe('tunnels handler > zone name caching', () => {
  it('retries getZoneName after a transient failure (cache cleared on rejection)', async () => {
    // First /zones/<id> call rejects; second succeeds. Without the
    // failure-clearing logic the rejection would be cached and every
    // subsequent named-tunnel get() would re-throw the same error.
    let zoneCallCount = 0;
    const fetcher = vi.fn<
      (input: string | URL, init?: RequestInit) => Promise<Response>
    >(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/zones/zone-id')) {
        zoneCallCount += 1;
        if (zoneCallCount === 1) {
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 500, message: 'flake' }]
            }),
            { status: 500, headers: { 'content-type': 'application/json' } }
          );
        }
        return jsonOk({ id: 'zone-id', name: 'example.com' });
      }
      if (method === 'GET' && url.includes('/cfd_tunnel?name=')) {
        return jsonOk([]);
      }
      if (method === 'POST' && url.endsWith('/cfd_tunnel')) {
        return jsonOk({
          id: '11111111-2222-3333-4444-555555555555',
          token: 'OPAQUE'
        });
      }
      if (method === 'GET' && url.includes('/dns_records?')) {
        return jsonOk([]);
      }
      if (method === 'POST' && url.includes('/dns_records')) {
        return jsonOk({ id: 'dns-id' });
      }
      throw new Error(`Unhandled ${method} ${url}`);
    });
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });

    // First call observes the 500 and rejects.
    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /Cloudflare API error/
    );
    // Second call retries the zone lookup and succeeds end-to-end.
    const info = await tunnels.get(8080, { name: 'api' });
    expect(info.hostname).toBe('api.example.com');
    expect(zoneCallCount).toBe(2);
  });
});

describe('tunnels handler > destroy() for named tunnels', () => {
  it('stops cloudflared, deletes the DNS record, and deletes the tunnel', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: '11111111-2222-3333-4444-555555555555'
    });

    await tunnels.get(8080, { name: 'api' });
    cf.fetcher.mockClear();
    await tunnels.destroy(8080);

    // Container was told to stop the cloudflared process.
    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(
      '11111111-2222-3333-4444-555555555555'
    );

    // CF API: one DELETE on the dns_records and one DELETE on the tunnel.
    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(targets.some((t) => t.includes('/dns_records/'))).toBe(true);
    expect(targets.some((t) => t.includes('/cfd_tunnel/'))).toBe(true);
  });

  it('uses stored accountId/zoneId from meta when the resolved config has drifted', async () => {
    // Tunnel was provisioned under (acct-A, zone-A) and its meta entry
    // records that. The user then changed CLOUDFLARE_ZONE_ID /
    // CLOUDFLARE_TUNNEL_ACCOUNT_ID, so the resolver now returns
    // (acct-B, zone-B). destroy() must clean up the original resources,
    // not point DELETE at the current (wrong) account/zone — otherwise
    // we'd 404 against zone-B while orphaning the live record in zone-A.
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: 'tunnel-uuid-stored',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        url: 'https://api.example.com',
        createdAt: '2026-05-13T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'dns-in-zone-A',
        accountId: 'acct-A',
        zoneId: 'zone-A'
      }
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: 'tunnel-uuid-stored'
    });
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const built = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger(),
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => ({
        token: 'TOK',
        accountId: 'acct-B',
        zoneId: 'zone-B'
      }),
      fetcher: fetcher as unknown as typeof fetch
    });

    await built.tunnels.destroy(8080);

    const deletes = fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    // DNS delete must target zone-A (where the record lives), not zone-B.
    expect(
      targets.some((t) => t.includes('/zones/zone-A/dns_records/dns-in-zone-A'))
    ).toBe(true);
    expect(targets.some((t) => t.includes('/zones/zone-B/'))).toBe(false);
    // Tunnel delete must target acct-A.
    expect(
      targets.some((t) =>
        t.includes('/accounts/acct-A/cfd_tunnel/tunnel-uuid-stored')
      )
    ).toBe(true);
    expect(targets.some((t) => t.includes('/accounts/acct-B/'))).toBe(false);
  });

  it('cleans up a hidden named tunnel that needs respawn', async () => {
    const cf = makeFakeCloudflare({});
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {});
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        tunnelId: 'tunnel-uuid-hidden',
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'dns-record-id',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        needsRespawn: true
      }
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: 'tunnel-uuid-hidden'
    });
    const built = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger(),
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => ({
        token: 'TOK',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }),
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await built.tunnels.destroy(8080);

    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith(
      'tunnel-uuid-hidden'
    );
    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(targets.some((t) => t.includes('/dns_records/'))).toBe(true);
    expect(targets.some((t) => t.includes('/cfd_tunnel/'))).toBe(true);
    const meta = (await (storage.get as StorageGetMock)(
      'tunnels:meta'
    )) as Record<string, unknown>;
    expect(meta).toEqual({});
  });

  it('continues Cloudflare cleanup when container tunnel teardown fails', async () => {
    const cf = makeFakeCloudflare({});
    const { client } = makeClient();
    const storage = makeStorage();
    await (storage.put as StoragePutMock)('tunnels', {
      '8080': {
        id: 'tunnel-uuid-stored',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        url: 'https://api.example.com',
        createdAt: '2026-05-13T00:00:00.000Z'
      }
    });
    await (storage.put as StoragePutMock)('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'dns-record-id',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }
    });
    client.tunnels.destroyTunnel.mockRejectedValue(
      new Error('container already stopped')
    );
    const built = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger: makeLogger(),
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => ({
        token: 'TOK',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }),
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(built.tunnels.destroy(8080)).resolves.toBeUndefined();

    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(targets.some((t) => t.includes('/dns_records/'))).toBe(true);
    expect(targets.some((t) => t.includes('/cfd_tunnel/'))).toBe(true);
  });

  it('quick-tunnel destroy() makes no Cloudflare API calls', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runQuickTunnel.mockResolvedValue({
      id: 'quick-abcd1234',
      port: 8080,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: 'quick-abcd1234'
    });

    await tunnels.get(8080);
    cf.fetcher.mockClear();
    await tunnels.destroy(8080);

    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.destroyTunnel).toHaveBeenCalledWith('quick-abcd1234');
  });

  it('best-effort: a CF DELETE failure is logged but does not throw', async () => {
    // First call resolves create OK, then DELETEs reject. We swap routes
    // by replacing the fetcher implementation after setup.
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: '11111111-2222-3333-4444-555555555555'
    });

    await tunnels.get(8080, { name: 'api' });

    // Now poison the fetcher so all DELETEs fail.
    cf.fetcher.mockImplementation(async (_input, init) => {
      if ((init as RequestInit | undefined)?.method === 'DELETE') {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 9999 }] }),
          { status: 500 }
        );
      }
      return new Response(JSON.stringify({ success: true, result: {} }), {
        status: 200
      });
    });

    // Should resolve, not reject, despite CF DELETE failures.
    await expect(tunnels.destroy(8080)).resolves.toBeUndefined();

    const cleanup = (await storage.get('tunnels:cleanup')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(cleanup['8080']).toEqual(
      expect.objectContaining({
        tunnelId: '11111111-2222-3333-4444-555555555555',
        dnsRecordId: 'dns-id',
        phase: 'claimed'
      })
    );
  });

  it('includes dnsRecordId in the warn log when CF cleanup is skipped due to missing credentials', async () => {
    // First call provisions a named tunnel with config available. Then
    // we flip the resolver to throw, simulating a token revocation
    // between get() and destroy(). The warn log must surface both the
    // tunnelId and the dnsRecordId so an operator can clean up by hand.
    const cf = makeFakeCloudflare({});
    const { client } = makeClient();
    const storage = makeStorage();
    const logger = makeLogger();
    let configShouldFail = false;
    const built = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger,
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => {
        if (configShouldFail) {
          throw new Error('CLOUDFLARE_API_TOKEN unbound');
        }
        return { token: 'TOK', accountId: 'ACCT', zoneId: 'zone-id' };
      },
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: '11111111-2222-3333-4444-555555555555'
    });

    await built.tunnels.get(8080, { name: 'api' });
    configShouldFail = true;
    await expect(built.tunnels.destroy(8080)).resolves.toBeUndefined();

    // The warn line must include enough information to identify the
    // orphaned Cloudflare resources (tunnel + DNS record).
    const warnCalls = (logger.warn as LogMock).mock.calls;
    const skipWarn = warnCalls.find(([msg]) =>
      String(msg).includes('skipping CF cleanup')
    );
    expect(skipWarn).toBeDefined();
    const context = skipWarn?.[1] as Record<string, unknown> | undefined;
    expect(context?.tunnelId).toBe('11111111-2222-3333-4444-555555555555');
    expect(context?.dnsRecordId).toBe('dns-id');

    const cleanup = (await storage.get('tunnels:cleanup')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(cleanup['8080']).toEqual(
      expect.objectContaining({
        tunnelId: '11111111-2222-3333-4444-555555555555',
        dnsRecordId: 'dns-id',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'claimed'
      })
    );
  });
});

describe('tunnels handler > destroyAll()', () => {
  it('tears down every stored tunnel — container, DNS, and CF tunnel resource', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, destroyAll } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel.mockResolvedValueOnce({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: '',
      hostname: '',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
    client.tunnels.runQuickTunnel.mockResolvedValueOnce({
      id: 'quick-abcd1234',
      port: 9090,
      url: 'https://stub.trycloudflare.com',
      hostname: 'stub.trycloudflare.com',
      createdAt: '2026-05-13T00:00:00.000Z'
    });
    client.tunnels.destroyTunnel.mockResolvedValue({
      success: true,
      id: 'irrelevant'
    });

    await tunnels.get(8080, { name: 'api' });
    await tunnels.get(9090);
    cf.fetcher.mockClear();

    await destroyAll();

    // Container told to stop BOTH tunnels.
    const destroyedIds = client.tunnels.destroyTunnel.mock.calls.map(
      (c) => c[0]
    );
    expect(destroyedIds.sort()).toEqual([
      '11111111-2222-3333-4444-555555555555',
      'quick-abcd1234'
    ]);

    // Named tunnel's CF resources removed; quick tunnel makes no CF calls.
    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(targets.some((t) => t.includes('/dns_records/'))).toBe(true);
    expect(targets.some((t) => t.includes('/cfd_tunnel/'))).toBe(true);

    // Storage is empty after destroyAll — list() reflects truth.
    expect(await tunnels.list()).toEqual([]);
  });

  it('resumes retained named tunnel cleanup records', async () => {
    const cf = makeFakeCloudflare({});
    const { client, storage, destroyAll } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await storage.put('tunnels:cleanup', {
      '8080': {
        tunnelId: 'tunnel-uuid-retained',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'dns-record-retained',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'claimed',
        updatedAt: '2026-05-13T00:00:00.000Z'
      }
    });

    await expect(destroyAll()).resolves.toBeUndefined();

    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();
    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(
      targets.some((t) => t.includes('/dns_records/dns-record-retained'))
    ).toBe(true);
    expect(
      targets.some((t) => t.includes('/cfd_tunnel/tunnel-uuid-retained'))
    ).toBe(true);
    expect(await storage.get('tunnels:cleanup')).toEqual({});
  });

  it('retains and logs retained cleanup records when named tunnel config is unavailable', async () => {
    const cf = makeFakeCloudflare({});
    const { client } = makeClient();
    const storage = makeStorage();
    const logger = makeLogger();
    await storage.put('tunnels:cleanup', {
      '8080': {
        tunnelId: 'tunnel-uuid-retained',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'dns-record-retained',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'claimed',
        updatedAt: '2026-05-13T00:00:00.000Z'
      }
    });
    const built = createTunnelsHandler({
      client: client as unknown as Parameters<
        typeof createTunnelsHandler
      >[0]['client'],
      storage,
      logger,
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(built.destroyAll()).resolves.toBeUndefined();

    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(await storage.get('tunnels:cleanup')).toEqual(
      expect.objectContaining({
        '8080': expect.objectContaining({
          tunnelId: 'tunnel-uuid-retained'
        })
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'tunnel.cleanup: credentials unavailable',
      expect.objectContaining({
        port: 8080,
        tunnelId: 'tunnel-uuid-retained',
        dnsRecordId: 'dns-record-retained'
      })
    );
  });

  it('is a no-op when no tunnels are stored', async () => {
    const cf = makeFakeCloudflare({});
    const { client, destroyAll } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await expect(destroyAll()).resolves.toBeUndefined();
    expect(client.tunnels.destroyTunnel).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });

  it('continues with the rest if one teardown fails (best-effort)', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, destroyAll } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.runNamedTunnel
      .mockResolvedValueOnce({
        id: 'tun-1',
        port: 8080,
        url: '',
        hostname: '',
        createdAt: '2026-05-13T00:00:00.000Z'
      })
      .mockResolvedValueOnce({
        id: 'tun-2',
        port: 8081,
        url: '',
        hostname: '',
        createdAt: '2026-05-13T00:00:00.000Z'
      });
    await tunnels.get(8080, { name: 'api' });
    await tunnels.get(8081, { name: 'web' });

    // First destroy throws; second should still happen.
    client.tunnels.destroyTunnel
      .mockRejectedValueOnce(new Error('container broken'))
      .mockResolvedValueOnce({ success: true, id: 'tun-2' });

    // destroyAll resolves even when individual destroys reject.
    await expect(destroyAll()).resolves.toBeUndefined();
    expect(client.tunnels.destroyTunnel).toHaveBeenCalledTimes(2);
  });
});
