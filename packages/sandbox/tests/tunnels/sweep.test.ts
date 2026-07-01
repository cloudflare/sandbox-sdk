import { describe, expect, it, vi } from 'vitest';
import { sweepStale } from '../../src/tunnels/sweep';

interface TunnelFixture {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface DNSFixture {
  id: string;
  name: string;
  type?: string;
  content: string;
  comment?: string | null;
  created_on?: string;
}

function jsonPage(body: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: body,
      result_info: {
        page: 1,
        per_page: 1000,
        total_pages: 1,
        count: body.length,
        total_count: body.length
      }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function jsonOK(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function buildFetcher(opts: {
  tunnels: TunnelFixture[];
  dns: DNSFixture[];
  failOnDelete?: (url: string) => Response | null;
}): {
  fetcher: typeof fetch;
  deletedTunnels: string[];
  deletedDNS: string[];
} {
  const deletedTunnels: string[] = [];
  const deletedDNS: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(String(input));

    if (method === 'GET' && url.pathname.endsWith('/cfd_tunnel')) {
      return jsonPage(opts.tunnels);
    }
    if (method === 'GET' && url.pathname.endsWith('/dns_records')) {
      return jsonPage(opts.dns);
    }
    if (method === 'DELETE' && url.pathname.includes('/cfd_tunnel/')) {
      const failure = opts.failOnDelete?.(String(input));
      if (failure) return failure;
      deletedTunnels.push(url.pathname.split('/cfd_tunnel/')[1]);
      return jsonOK({ id: 'ok' });
    }
    if (method === 'DELETE' && url.pathname.includes('/dns_records/')) {
      const failure = opts.failOnDelete?.(String(input));
      if (failure) return failure;
      deletedDNS.push(url.pathname.split('/dns_records/')[1]);
      return jsonOK({ id: 'ok' });
    }

    throw new Error(`unexpected request: ${method} ${String(input)}`);
  });
  return { fetcher, deletedTunnels, deletedDNS };
}

const NOW = new Date('2026-05-26T12:00:00Z');
const ONE_DAY_MS = 24 * 60 * 60_000;

function tunnel(overrides: Partial<TunnelFixture>): TunnelFixture {
  return {
    id: 'tun-id',
    name: 'sandbox-sb-api',
    status: 'down',
    created_at: '2026-05-01T00:00:00Z',
    conns_active_at: null,
    conns_inactive_at: null,
    deleted_at: null,
    metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb' },
    ...overrides
  };
}

function dns(overrides: Partial<DNSFixture>): DNSFixture {
  return {
    id: 'rec-id',
    name: 'api.example.com',
    type: 'CNAME',
    content: 'missing-tun.cfargotunnel.com',
    comment: 'sandbox-sb',
    created_on: '2026-05-01T00:00:00Z',
    ...overrides
  };
}

describe('sweepStale', () => {
  it('deletes a stale tunnel and reports the completed deletion', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'stale-tun',
          conns_inactive_at: new Date(
            NOW.getTime() - 2 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: []
    });

    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );

    expect(deletedTunnels).toEqual(['stale-tun']);
    expect(result.tunnelsDeleted).toEqual([
      { id: 'stale-tun', name: 'sandbox-sb-api' }
    ]);
    expect(result.tunnelsScanned).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('refuses to delete an SDK tunnel without a sandboxId', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'no-sb-id',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: { createdBy: 'sandbox-sdk' }
        })
      ],
      dns: []
    });

    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );

    expect(deletedTunnels).toEqual([]);
    expect(result.errors).toEqual([
      {
        resource: 'tunnel',
        id: 'no-sb-id',
        message: 'missing-identifying-metadata'
      }
    ]);
  });

  it('deletes a stale tunnel and its paired CNAME in the same sweep', async () => {
    const { fetcher, deletedTunnels, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'stale-tun',
          conns_inactive_at: new Date(
            NOW.getTime() - 2 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: [
        dns({
          id: 'rec-stale',
          content: 'stale-tun.cfargotunnel.com'
        })
      ]
    });

    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );

    expect(deletedTunnels).toEqual(['stale-tun']);
    expect(deletedDNS).toEqual(['rec-stale']);
    expect(result.dnsScanned).toBe(1);
    expect(result.dnsDeleted).toEqual([
      { id: 'rec-stale', name: 'api.example.com' }
    ]);
  });

  it('keeps DNS when the target tunnel exists outside SDK metadata', async () => {
    const { fetcher, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'live-raw-tun',
          status: 'healthy',
          metadata: { createdBy: 'another-tool' }
        })
      ],
      dns: [
        dns({
          id: 'points-at-live-raw-tunnel',
          content: 'live-raw-tun.cfargotunnel.com'
        })
      ]
    });

    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );

    expect(deletedDNS).toEqual([]);
    expect(result.dnsScanned).toBe(1);
    expect(result.dnsDeleted).toEqual([]);
  });

  it('reports planned deletes in dry run without issuing DELETE requests', async () => {
    const { fetcher, deletedTunnels, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'would-delete',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: [
        dns({
          id: 'would-delete-dns',
          name: 'old.example.com',
          content: 'no-such-tunnel.cfargotunnel.com'
        })
      ]
    });

    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW, dryRun: true }
    );

    expect(deletedTunnels).toEqual([]);
    expect(deletedDNS).toEqual([]);
    expect(result.tunnelsDeleted).toEqual([
      { id: 'would-delete', name: 'sandbox-sb-api' }
    ]);
    expect(result.dnsDeleted).toEqual([
      { id: 'would-delete-dns', name: 'old.example.com' }
    ]);
  });

  it('records per-resource delete failures without aborting the sweep', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'fail-tun',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        }),
        tunnel({
          id: 'ok-tun',
          name: 'sandbox-sb-other',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: [],
      failOnDelete: (url) =>
        url.includes('fail-tun')
          ? new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 9999, message: 'transient' }]
              }),
              { status: 500, headers: { 'content-type': 'application/json' } }
            )
          : null
    });

    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );

    expect(deletedTunnels).toEqual(['ok-tun']);
    expect(result.tunnelsDeleted).toEqual([
      { id: 'ok-tun', name: 'sandbox-sb-other' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      resource: 'tunnel',
      id: 'fail-tun'
    });
    expect(result.errors[0].message).toMatch(/9999|transient/);
  });

  it('rejects invalid staleAfterMs before issuing Cloudflare requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      sweepStale(
        { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
        { staleAfterMs: -1, now: NOW }
      )
    ).rejects.toThrow(/staleAfterMs/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('scopes deletions to the requested sandboxId', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'sb1-tun',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb1' }
        }),
        tunnel({
          id: 'sb2-tun',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb2' }
        })
      ],
      dns: []
    });

    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW, sandboxId: 'sb1' }
    );

    expect(deletedTunnels).toEqual(['sb1-tun']);
  });
});
