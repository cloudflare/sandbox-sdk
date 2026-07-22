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
import { ErrorCode, RPCTransportError } from '../../src/errors';
import { RuntimeIdentityInactiveError } from '../../src/runtime/types';
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

describe('tunnel service > get(port, { name }) — named tunnel happy path', () => {
  it('provisions a fresh named tunnel end-to-end', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    mockNamedSpawn(client);

    const info = await tunnels.get(8080, { name: 'api' });

    expect(info.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(info.port).toBe(8080);
    expect(info.name).toBe('api');
    expect(info.hostname).toBe('api.example.com');
    expect(info.url).toBe('https://api.example.com');
    expect(typeof info.createdAt).toBe('string');

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    const [request] = client.tunnels.ensureTunnelRun.mock.calls[0];
    expect(request).toMatchObject({
      mode: 'named',
      tunnelId: NAMED_TUNNEL_ID,
      port: 8080,
      cloudflaredToken: 'OPAQUE_TOKEN'
    });
    expect(request.runId).toEqual(expect.any(String));
    expect(JSON.stringify(info)).not.toContain('OPAQUE_TOKEN');
  });

  it('surfaces RPC transport loss without replaying the named tunnel run', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    const error = createDisposedRPCError();
    client.tunnels.ensureTunnelRun.mockRejectedValueOnce(error);

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toBe(error);

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
  });

  it('does not consult the transitional runtime fence while provisioning', async () => {
    const cf = makeFakeCloudflare({});
    const assertActive = vi.fn(async () => {
      throw new RuntimeIdentityInactiveError();
    });
    const { client, tunnels } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch,
      fences: makeFences({ currentRuntime: { assertActive } })
    });
    mockNamedSpawn(client);

    await expect(tunnels.get(8080, { name: 'api' })).resolves.toMatchObject({
      name: 'api'
    });
    expect(assertActive).not.toHaveBeenCalled();
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
  });

  it('does not spawn or commit when lifetime changes during Cloudflare setup', async () => {
    const cf = makeFakeCloudflare({});
    let assertCalls = 0;
    const { client, storage, tunnels } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch,
      fences: makeFences({
        currentLifetime: {
          assertCurrent: vi.fn(async () => {
            assertCalls += 1;
            if (assertCalls === 1) {
              throw new SandboxLifetimeChangedError();
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
        reason: 'sandbox_lifetime_changed',
        operation: 'tunnel.get',
        retryable: false,
        admitted: true
      })
    });
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
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

describe('tunnel service > get(port, options) — idempotency / hash guard', () => {
  it('returns the cached record on identical second call (no work performed)', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    const first = await tunnels.get(8080, { name: 'api' });
    cf.fetcher.mockClear();
    client.tunnels.ensureTunnelRun.mockClear();

    const second = await tunnels.get(8080, { name: 'api' });
    expect(second).toEqual(first);
    // No CF API calls, no container RPC.
    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
  });

  it('respawns an unscoped named record instead of returning it as current', async () => {
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
          id: 'dns-kept',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'kept-tun-id.cfargotunnel.com',
          comment: 'sandbox-sb1'
        }
      ]
    });
    const { tunnels, client, storage } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch,
      fences: makeFences()
    });
    await storage.put('tunnels', {
      '8080': {
        id: 'kept-tun-id',
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        url: 'https://api.example.com',
        createdAt: '2026-05-13T00:00:00.000Z'
      }
    });
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        dnsRecordId: 'dns-kept',
        tunnelId: 'kept-tun-id',
        name: 'api',
        hostname: 'api.example.com',
        accountId: 'ACCT',
        zoneId: 'zone-id'
      }
    });

    const info = await tunnels.get(8080, { name: 'api' });

    expect(info.id).toBe('kept-tun-id');
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
    const meta =
      await storage.get<Record<string, Record<string, unknown>>>(
        'tunnels:meta'
      );
    expect(meta?.['8080']?.runtimeIdentityID).toBe('runtime-1');
    expect(meta?.['8080']?.tunnelRunId).toEqual(expect.any(String));
  });

  it('quick → named on same port throws', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await tunnels.get(8080);

    await expect(tunnels.get(8080, { name: 'api' })).rejects.toThrow(
      /destroy/i
    );
  });

  it('named → named with different name on same port throws', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels } = makeHandler({
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await tunnels.get(8080, { name: 'api' });
    await expect(tunnels.get(8080, { name: 'web' })).rejects.toThrow(
      /destroy/i
    );
  });

  it('re-provisions when CLOUDFLARE_ZONE_ID changes between calls (no stale URL)', async () => {
    const { client } = makeClient();
    mockTunnelRun(client);
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
    const built = createTunnelsHandle({
      runRuntimeCall: ((operation, call) =>
        call(
          client.tunnels as unknown as Parameters<
            Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall']
          >[1] extends (tunnels: infer U) => Promise<unknown>
            ? U
            : never
        )) as Parameters<typeof createTunnelsHandle>[0]['runRuntimeCall'],
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

    const a = await tunnels.get(8080);
    const b = await tunnels.get(8080, {});
    expect(b).toEqual(a);
    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(1);
  });

  it('treats legacy unversioned hashes as equivalent to v1: hashes on cache hit', async () => {
    // Forward compat: an existing deploy may have stored optionsHash
    // 'quick' or 'named:foo' (no version prefix). The cache-hit
    // comparison treats those as equivalent to the v1-prefixed form so
    // live tunnels keep matching across the format bump.
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
        zoneId: 'zone-id',
        runtimeIdentityID: 'runtime-1',
        runtimeIncarnationID: 'inc-1'
      }
    });

    const info = await tunnels.get(8080, { name: 'api' });
    expect(info.hostname).toBe('api.example.com');
    // Cache hit: no container call, no CF API calls.
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });
});
