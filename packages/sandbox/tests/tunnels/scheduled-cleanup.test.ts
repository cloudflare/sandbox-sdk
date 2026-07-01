import { describe, expect, it, vi } from 'vitest';
import { createScheduledTunnelCleanupHandler } from '../../src/tunnels/scheduled-cleanup';

const STALE_AFTER_MS = 24 * 60 * 60_000;

interface ScheduledControllerFixture {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

function controller(cron = '0 3 * * *'): ScheduledControllerFixture {
  return { scheduledTime: 0, cron, noRetry: () => {} };
}

function jsonOK(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function jsonPage(body: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: body,
      result_info: { page: 1, per_page: 1000, total_pages: 1 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function buildCtx(): {
  ctx: {
    waitUntil: (promise: Promise<unknown>) => void;
    passThroughOnException: () => void;
  };
  waited: Promise<unknown>[];
} {
  const waited: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise) => {
        waited.push(promise);
      },
      passThroughOnException: () => {}
    },
    waited
  };
}

function routedFetcher(
  routes: Record<string, Response | ((url: URL) => Response)>
): typeof fetch {
  const ordered = Object.entries(routes).sort(
    ([a], [b]) => b.length - a.length
  );
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    for (const [match, response] of ordered) {
      if (url.toString().includes(match)) {
        return typeof response === 'function'
          ? response(url)
          : response.clone();
      }
    }
    return new Response(`No mock route for ${url.toString()}`, { status: 599 });
  });
}

describe('createScheduledTunnelCleanupHandler', () => {
  it('runs cleanup in waitUntil using env credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonPage([]));
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onResult: vi.fn()
    });
    const { ctx, waited } = buildCtx();

    await handler(
      controller(),
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx
    );

    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    const urls = fetcher.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/cfd_tunnel'))).toBe(true);
    expect(urls.some((u) => u.includes('/dns_records'))).toBe(true);
  });

  it('infers account and zone IDs from the token when env IDs are omitted', async () => {
    const fetcher = routedFetcher({
      '/user/tokens/verify': new Response(
        JSON.stringify({
          success: true,
          result: { id: 'token-id', status: 'active' },
          result_info: { account: { id: 'acct' } }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
      '/zones?': jsonOK([{ id: 'zone', name: 'example.com' }]),
      '/cfd_tunnel': jsonPage([]),
      '/dns_records': jsonPage([])
    });
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onResult: vi.fn()
    });
    const { ctx, waited } = buildCtx();

    await handler(controller(), { CLOUDFLARE_API_TOKEN: 'tok' }, ctx);

    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    const urls = vi.mocked(fetcher).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/user/tokens/verify'))).toBe(true);
    expect(urls.some((u) => u.includes('/zones?'))).toBe(true);
    expect(urls.some((u) => u.includes('/cfd_tunnel'))).toBe(true);
    expect(urls.some((u) => u.includes('/dns_records'))).toBe(true);
  });

  it('falls back to tunnel-only cleanup when zone inference fails', async () => {
    const onError = vi.fn();
    const fetcher = routedFetcher({
      '/user/tokens/verify': new Response(
        JSON.stringify({
          success: true,
          result: { id: 'token-id', status: 'active' },
          result_info: { account: { id: 'acct' } }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
      '/zones?': jsonOK([
        { id: 'zone-a', name: 'a.example' },
        { id: 'zone-b', name: 'b.example' }
      ]),
      '/cfd_tunnel': jsonPage([])
    });
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onError,
      onResult: vi.fn()
    });
    const { ctx, waited } = buildCtx();

    await handler(controller(), { CLOUDFLARE_API_TOKEN: 'tok' }, ctx);

    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    const urls = vi.mocked(fetcher).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/cfd_tunnel'))).toBe(true);
    expect(urls.some((u) => u.includes('/dns_records'))).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/multiple zones/i);
  });

  it('is a no-op when CLOUDFLARE_API_TOKEN is missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onResult: vi.fn()
    });
    const { ctx, waited } = buildCtx();

    await handler(
      controller(),
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_ZONE_ID: 'zone' },
      ctx
    );

    expect(waited).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports account inference failures without rejecting cron work', async () => {
    const onError = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: { id: 'token-id', status: 'active' },
            result_info: {}
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onError,
      onResult: vi.fn()
    });
    const { ctx, waited } = buildCtx();

    await handler(
      controller(),
      { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ZONE_ID: 'zone' },
      ctx
    );

    expect(waited).toHaveLength(1);
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/single account/i);
  });

  it('swallows sweep failures so cron does not retry on transient errors', async () => {
    const onError = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('boom', { status: 500 })
    );
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onError,
      onResult: vi.fn()
    });
    const { ctx, waited } = buildCtx();

    await handler(
      controller(),
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx
    );

    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('routes onResult failures to onError without rejecting waitUntil', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonPage([]));
    const resultError = new Error('metrics sink unavailable');
    const onResult = vi.fn(async () => {
      throw resultError;
    });
    const onError = vi.fn();
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      fetcher,
      onResult,
      onError
    });
    const { ctx, waited } = buildCtx();

    await handler(
      controller(),
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx
    );

    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(resultError);
  });

  it('passes sandboxId through to the sweep', async () => {
    const deletedTunnels: string[] = [];
    const staleTimestamp = new Date(
      Date.now() - 2 * STALE_AFTER_MS
    ).toISOString();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = new URL(String(input));
      if (method === 'GET' && url.pathname.endsWith('/cfd_tunnel')) {
        return jsonPage([
          {
            id: 'sb1-tun',
            name: 'sandbox-sb1-api',
            status: 'down',
            created_at: staleTimestamp,
            conns_active_at: null,
            conns_inactive_at: staleTimestamp,
            deleted_at: null,
            metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb1' }
          },
          {
            id: 'sb2-tun',
            name: 'sandbox-sb2-api',
            status: 'down',
            created_at: staleTimestamp,
            conns_active_at: null,
            conns_inactive_at: staleTimestamp,
            deleted_at: null,
            metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb2' }
          }
        ]);
      }
      if (method === 'GET' && url.pathname.endsWith('/dns_records')) {
        return jsonPage([]);
      }
      if (method === 'DELETE' && url.pathname.includes('/cfd_tunnel/')) {
        deletedTunnels.push(url.pathname.split('/cfd_tunnel/')[1]);
        return jsonOK({ id: 'ok' });
      }
      throw new Error(`unexpected request: ${method} ${String(input)}`);
    });
    const onResult = vi.fn();
    const handler = createScheduledTunnelCleanupHandler({
      staleAfterMs: STALE_AFTER_MS,
      sandboxId: 'sb1',
      fetcher,
      onResult
    });
    const { ctx, waited } = buildCtx();

    await handler(
      controller(),
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx
    );
    await Promise.all(waited);

    expect(deletedTunnels).toEqual(['sb1-tun']);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tunnelsDeleted: [{ id: 'sb1-tun', name: 'sandbox-sb1-api' }]
      })
    );
  });
});
