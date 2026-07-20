import {
  completeTunnelServiceHost,
  type TestTunnelServiceHost
} from './helpers';
/**
 * Named-tunnel behavior tests for the SDK tunnel service.
 *
 * Sibling to `tunnel-service-quick.test.ts` (which covers the quick-tunnel
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

import type {
  EnsureTunnelRunRequest,
  EnsureTunnelRunResult,
  StopTunnelRunRequest,
  StopTunnelRunResult,
  TunnelInfo
} from '@repo/shared';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeIdentityInactiveError } from '../../src/current-runtime-identity';
import { ErrorCode, RPCTransportError } from '../../src/errors';
import { SandboxLifetimeChangedError } from '../../src/sandbox-lifetime';
import { SandboxSecurityError } from '../../src/security';
import {
  createTunnelsHandle as createRuntimeTunnelsHandle,
  type TunnelsStorage
} from '../../src/tunnels/rpc-target';
import { makeFences, makeLogger, makeStorage } from './helpers';

type EnsureTunnelRunMock = Mock<
  (request: EnsureTunnelRunRequest) => Promise<EnsureTunnelRunResult>
>;
type StopTunnelRunMock = Mock<
  (request: StopTunnelRunRequest) => Promise<StopTunnelRunResult>
>;
type FetcherMock = Mock<
  (input: string | URL, init?: RequestInit) => Promise<Response>
>;
type StorageGetMock = Mock<(key: string) => Promise<unknown>>;
type StoragePutMock = Mock<(key: string, next: unknown) => Promise<unknown>>;
type LogMock = Mock<(message: string, ...context: unknown[]) => void>;

function createDisposedRPCError(): RPCTransportError {
  return new RPCTransportError({
    code: ErrorCode.RPC_TRANSPORT_ERROR,
    message: 'RPC session was shut down by disposing the main stub',
    httpStatus: 503,
    context: {
      kind: 'session_disposed',
      originalMessage: 'RPC session was shut down by disposing the main stub',
      errorName: 'Error'
    },
    timestamp: '2026-06-22T12:00:00.000Z'
  });
}

interface MockTunnelsClient {
  ensureTunnelRun: EnsureTunnelRunMock;
  stopTunnelRun: StopTunnelRunMock;
}

function makeClient(): { client: { tunnels: MockTunnelsClient } } {
  return {
    client: {
      tunnels: {
        ensureTunnelRun:
          vi.fn<
            (request: EnsureTunnelRunRequest) => Promise<EnsureTunnelRunResult>
          >(),
        stopTunnelRun:
          vi.fn<
            (request: StopTunnelRunRequest) => Promise<StopTunnelRunResult>
          >()
      }
    }
  };
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

type TunnelsHost = Parameters<typeof createTunnelsHandle>[0];

const NAMED_TUNNEL_ID = '11111111-2222-3333-4444-555555555555';

function namedRunResult(
  request: EnsureTunnelRunRequest
): EnsureTunnelRunResult {
  if (request.mode !== 'named') {
    throw new Error('Expected a named tunnel run request');
  }
  return {
    started: true,
    run: {
      mode: 'named',
      tunnelId: request.tunnelId,
      runId: request.runId,
      port: request.port,
      startedAt: '2026-05-13T00:00:00.000Z'
    }
  };
}

function quickRunResult(
  request: EnsureTunnelRunRequest
): EnsureTunnelRunResult {
  if (request.mode !== 'quick') {
    throw new Error('Expected a quick tunnel run request');
  }
  const hostname = 'quick.trycloudflare.com';
  return {
    started: true,
    run: {
      mode: 'quick',
      tunnelId: request.tunnelId,
      runId: request.runId,
      port: request.port,
      url: `https://${hostname}`,
      hostname,
      startedAt: '2026-05-13T00:00:00.000Z'
    }
  };
}

function mockTunnelRun(client: { tunnels: MockTunnelsClient }): void {
  client.tunnels.ensureTunnelRun.mockImplementation(async (request) =>
    request.mode === 'named' ? namedRunResult(request) : quickRunResult(request)
  );
}

function mockNamedSpawn(client: { tunnels: MockTunnelsClient }): void {
  mockTunnelRun(client);
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
  fences?: Pick<TunnelsHost, 'getStoredRuntime' | 'currentLifetime'>;
}) {
  const { client } = makeClient();
  mockTunnelRun(client);
  const storage = makeStorage();
  const logger = makeLogger();
  const namedTunnelConfig = {
    token: opts?.config?.token ?? 'TOK',
    accountId: opts?.config?.accountId ?? 'ACCT',
    zoneId: opts?.config?.zoneId ?? 'zone-id'
  };
  const built = createTunnelsHandle({
    runRuntimeCall: ((operation, call) =>
      call(
        client.tunnels as unknown as TunnelsHost['runRuntimeCall'] extends (
          op: string,
          call: (tunnels: infer U) => Promise<unknown>
        ) => Promise<unknown>
          ? U
          : never
      )) as TunnelsHost['runRuntimeCall'],
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

const createTunnelsHandle = (host: TestTunnelServiceHost) =>
  createRuntimeTunnelsHandle(completeTunnelServiceHost(host));

describe('tunnel service > get(port, { name }) — retry / reuse', () => {
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

  it('writes named resource intent before creating a Cloudflare tunnel', async () => {
    const cf = makeFakeCloudflare({});
    const { client } = makeClient();
    mockNamedSpawn(client);
    const storage = makeStorage();
    const logger = makeLogger();
    const fetcher = vi.fn<
      (input: string | URL, init?: RequestInit) => Promise<Response>
    >(async (input, init) => {
      const url = String(input);
      if (
        (init?.method ?? 'GET').toUpperCase() === 'POST' &&
        new URL(url).pathname.endsWith('/cfd_tunnel')
      ) {
        await expect(storage.get('tunnels:cleanup')).resolves.toEqual({
          '8080': expect.objectContaining({
            port: 8080,
            name: 'api',
            hostname: 'api.example.com',
            tunnelName: 'sandbox-sb1-api',
            sandboxId: 'sb1',
            accountId: 'ACCT',
            zoneId: 'zone-id',
            phase: 'planned'
          })
        });
      }
      return cf.fetcher(input, init);
    });

    const { tunnels } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as TunnelsHost['runRuntimeCall'] extends (
            op: string,
            call: (tunnels: infer U) => Promise<unknown>
          ) => Promise<unknown>
            ? U
            : never
        )) as TunnelsHost['runRuntimeCall'],
      storage,
      logger,
      sandboxId: 'sb1',
      getNamedTunnelConfig: async () => ({
        token: 'TOK',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }),
      fetcher: fetcher as unknown as typeof fetch
    });

    await tunnels.get(8080, { name: 'api' });

    expect(fetcher).toHaveBeenCalled();
  });

  it('records cleanup authority when DNS upsert fails after tunnel create', async () => {
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
    const { tunnels, client, storage, resumeCleanup } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /already exists|owned/i
    );
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
    await expect(storage.get('tunnels:cleanup')).resolves.toEqual({
      '8080': expect.objectContaining({
        tunnelId: NAMED_TUNNEL_ID,
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        tunnelName: 'sandbox-sb1-api',
        sandboxId: 'sb1',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'tunnel_ready'
      })
    });

    await resumeCleanup();

    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(
      targets.some((t) => t.includes(`/cfd_tunnel/${NAMED_TUNNEL_ID}`))
    ).toBe(true);
    expect(targets.some((t) => t.includes('/dns_records/foreign-dns'))).toBe(
      false
    );
    await expect(storage.get('tunnels:cleanup')).resolves.toEqual({});
  });

  it('leaves CF resources in place when cloudflared fails to become ready', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.ensureTunnelRun.mockRejectedValue(
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

    // Public storage is still empty, but cleanup intent is durable.
    await expect(storage.get('tunnels')).resolves.toBeUndefined();
    await expect(storage.get('tunnels:meta')).resolves.toBeUndefined();
    await expect(storage.get('tunnels:cleanup')).resolves.toEqual({
      '8080': {
        tunnelId: '11111111-2222-3333-4444-555555555555',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'dns-id',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'claimed',
        updatedAt: expect.any(String)
      }
    });
  });
});

describe('tunnel service > restart respawn via needsRespawn flag', () => {
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
    mockTunnelRun(client);
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
    const { tunnels } = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
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
    } as unknown as Parameters<typeof createTunnelsHandle>[0]);

    const info = await tunnels.get(8080, { name: 'api' });

    expect(info.id).toBe('kept-tun-id');
    expect(info.hostname).toBe('api.example.com');
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'named',
        tunnelId: 'kept-tun-id',
        cloudflaredToken: 'REUSED_TOKEN',
        port: 8080,
        runId: expect.any(String)
      })
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
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
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

    const info = await tunnels.get(8080, { name: 'api' });

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
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

describe('tunnel service > get(port, { name }) — synchronous validation', () => {
  it('rejects invalid name format without any work', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(
      tunnels.get(8080, { name: 'BAD.NAME' })
    ).rejects.toBeInstanceOf(SandboxSecurityError);
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
  });

  it('rejects invalid port without any work', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(tunnels.get(3000, { name: 'api' })).rejects.toThrow(/port/i);
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
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
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
  });
});

describe('tunnel service > zone name caching', () => {
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
