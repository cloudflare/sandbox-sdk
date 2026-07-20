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
      getNamedTunnelConfig: async () => {
        if (configShouldFail) {
          throw new Error('CLOUDFLARE_API_TOKEN unbound');
        }
        return { token: 'TOK', accountId: 'ACCT', zoneId: 'zone-id' };
      },
      fetcher: cf.fetcher as unknown as typeof fetch
    });
    client.tunnels.stopTunnelRun.mockResolvedValue({
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
      .mockResolvedValueOnce({ stopped: true });

    await expect(destroyAll()).resolves.toBeUndefined();
    expect(client.tunnels.stopTunnelRun).toHaveBeenCalledTimes(2);
  });
});
