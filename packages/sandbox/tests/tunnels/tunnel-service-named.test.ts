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
  createTunnelsHandle,
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
  fences?: Pick<TunnelsHost, 'currentRuntime' | 'currentLifetime'>;
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

  it('replays the same named run request when the first call loses RPC transport', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.ensureTunnelRun
      .mockRejectedValueOnce(createDisposedRPCError())
      .mockImplementationOnce(async (request) => namedRunResult(request));

    const info = await tunnels.get(8080, { name: 'api' });

    expect(client.tunnels.ensureTunnelRun).toHaveBeenCalledTimes(2);
    const first = client.tunnels.ensureTunnelRun.mock.calls[0][0];
    const second = client.tunnels.ensureTunnelRun.mock.calls[1][0];
    expect(second).toEqual(first);
    expect(info).toMatchObject({
      id: NAMED_TUNNEL_ID,
      port: 8080,
      name: 'api',
      hostname: 'api.example.com',
      url: 'https://api.example.com'
    });
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
            if (assertCalls % 3 === 0) {
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
        admitted: 'unknown'
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
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
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
        zoneId: 'zone-id'
      }
    });

    const info = await tunnels.get(8080, { name: 'api' });
    expect(info.hostname).toBe('api.example.com');
    // Cache hit: no container call, no CF API calls.
    expect(client.tunnels.ensureTunnelRun).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });
});

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
      client: client as unknown as TunnelsHost['client'],
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
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
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

describe('tunnel service > destroy() for named tunnels', () => {
  it('resumes retained cleanup when the public tunnel record is gone', async () => {
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

    await tunnels.destroy(8080);

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
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
    await expect(storage.get('tunnels:cleanup')).resolves.toEqual({});
  });

  it('stops cloudflared, deletes the DNS record, and deletes the tunnel', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await tunnels.get(8080, { name: 'api' });
    cf.fetcher.mockClear();
    await tunnels.destroy(8080);

    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledWith({
      tunnelId: '11111111-2222-3333-4444-555555555555',
      runId: expect.any(String)
    });

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
    client.tunnels.stopTunnelRun.mockResolvedValue({
      matched: true,
      stopped: true
    });
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const built = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
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
    const built = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
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

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
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
    client.tunnels.stopTunnelRun.mockRejectedValue(
      new Error('container already stopped')
    );
    const built = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
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
    client.tunnels.stopTunnelRun.mockResolvedValue({
      matched: true,
      stopped: true
    });

    const info = await tunnels.get(8080);
    cf.fetcher.mockClear();
    await tunnels.destroy(8080);

    expect(cf.fetcher).not.toHaveBeenCalled();
    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledWith({
      tunnelId: info.id,
      runId: expect.any(String)
    });
  });

  it('best-effort: a CF DELETE failure is logged but does not throw', async () => {
    // First call resolves create OK, then DELETEs reject. We swap routes
    // by replacing the fetcher implementation after setup.
    const cf = makeFakeCloudflare({});
    const { tunnels, client, storage } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.stopTunnelRun.mockResolvedValue({
      matched: true,
      stopped: true
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
    mockTunnelRun(client);
    const storage = makeStorage();
    const logger = makeLogger();
    let configShouldFail = false;
    const built = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
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
    client.tunnels.stopTunnelRun.mockResolvedValue({
      matched: true,
      stopped: true
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

describe('tunnel service > destroyAll()', () => {
  it('tears down every stored tunnel — container, DNS, and CF tunnel resource', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, destroyAll } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await tunnels.get(8080, { name: 'api' });
    const quick = await tunnels.get(9090);
    cf.fetcher.mockClear();

    await destroyAll();

    const stoppedIds = client.tunnels.stopTunnelRun.mock.calls.map(
      ([request]) => request.tunnelId
    );
    expect(stoppedIds.sort()).toEqual([
      '11111111-2222-3333-4444-555555555555',
      quick.id
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

  it('cleans hidden named tunnels that are waiting for respawn', async () => {
    const cf = makeFakeCloudflare({});
    const { client, storage, destroyAll } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await storage.put('tunnels', {});
    await storage.put('tunnels:meta', {
      '8080': {
        optionsHash: 'v1:named:api',
        tunnelId: 'tunnel-uuid-hidden',
        name: 'api',
        hostname: 'api.example.com',
        dnsRecordId: 'dns-record-hidden',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        needsRespawn: true
      }
    });
    await expect(destroyAll()).resolves.toBeUndefined();

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(
      targets.some((t) => t.includes('/dns_records/dns-record-hidden'))
    ).toBe(true);
    expect(
      targets.some((t) => t.includes('/cfd_tunnel/tunnel-uuid-hidden'))
    ).toBe(true);
    await expect(storage.get('tunnels:meta')).resolves.toEqual({});
  });

  it('retains discovered resource ids when planned cleanup partially fails', async () => {
    const cf = makeFakeCloudflare({
      existingTunnels: [
        {
          id: 'tunnel-uuid-planned',
          name: 'sandbox-sb1-api',
          deleted_at: null,
          metadata: { sandboxId: 'sb1', createdBy: 'sandbox-sdk' }
        }
      ],
      existingDns: [
        {
          id: 'dns-record-planned',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'tunnel-uuid-planned.cfargotunnel.com',
          comment: 'sandbox-sb1'
        }
      ]
    });
    const fetcher = vi.fn<
      (input: string | URL, init?: RequestInit) => Promise<Response>
    >(async (input, init) => {
      const url = String(input);
      if (
        (init?.method ?? 'GET').toUpperCase() === 'DELETE' &&
        url.includes('/dns_records/dns-record-planned')
      ) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 9999 }] }),
          { status: 500 }
        );
      }
      return cf.fetcher(input, init);
    });
    const { storage, resumeCleanup } = makeHandler({
      sandboxId: 'sb1',
      fetcher: fetcher as unknown as typeof fetch
    });
    await storage.put('tunnels:cleanup', {
      '8080': {
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        tunnelName: 'sandbox-sb1-api',
        sandboxId: 'sb1',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'planned',
        updatedAt: '2026-05-13T00:00:00.000Z'
      }
    });

    await resumeCleanup();

    await expect(storage.get('tunnels:cleanup')).resolves.toEqual({
      '8080': expect.objectContaining({
        tunnelId: 'tunnel-uuid-planned',
        dnsRecordId: 'dns-record-planned',
        phase: 'claimed'
      })
    });
  });

  it('resumes planned cleanup by discovering named resources', async () => {
    const cf = makeFakeCloudflare({
      existingTunnels: [
        {
          id: 'tunnel-uuid-planned',
          name: 'sandbox-sb1-api',
          deleted_at: null,
          metadata: { sandboxId: 'sb1', createdBy: 'sandbox-sdk' }
        }
      ],
      existingDns: [
        {
          id: 'dns-record-planned',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'tunnel-uuid-planned.cfargotunnel.com',
          comment: 'sandbox-sb1'
        }
      ]
    });
    const { storage, resumeCleanup } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await storage.put('tunnels:cleanup', {
      '8080': {
        port: 8080,
        name: 'api',
        hostname: 'api.example.com',
        tunnelName: 'sandbox-sb1-api',
        sandboxId: 'sb1',
        accountId: 'ACCT',
        zoneId: 'zone-id',
        phase: 'planned',
        updatedAt: '2026-05-13T00:00:00.000Z'
      }
    });

    await resumeCleanup();

    const deletes = cf.fetcher.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    const targets = deletes.map(([url]) => String(url));
    expect(
      targets.some((t) => t.includes('/dns_records/dns-record-planned'))
    ).toBe(true);
    expect(
      targets.some((t) => t.includes('/cfd_tunnel/tunnel-uuid-planned'))
    ).toBe(true);
    expect(await storage.get('tunnels:cleanup')).toEqual({});
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

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
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
    const built = createTunnelsHandle({
      client: client as unknown as Parameters<
        typeof createTunnelsHandle
      >[0]['client'],
      storage,
      logger,
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });

    await expect(built.destroyAll()).resolves.toBeUndefined();

    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
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
    expect(client.tunnels.stopTunnelRun).not.toHaveBeenCalled();
    expect(cf.fetcher).not.toHaveBeenCalled();
  });

  it('continues with the rest if one teardown fails (best-effort)', async () => {
    const cf = makeFakeCloudflare({});
    const { tunnels, client, destroyAll } = makeHandler({
      sandboxId: 'sb1',
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    await tunnels.get(8080, { name: 'api' });
    await tunnels.get(8081, { name: 'web' });

    client.tunnels.stopTunnelRun
      .mockRejectedValueOnce(new Error('container broken'))
      .mockResolvedValueOnce({ matched: true, stopped: true });

    await expect(destroyAll()).resolves.toBeUndefined();
    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledTimes(2);
  });
});
