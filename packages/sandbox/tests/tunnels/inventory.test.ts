import { describe, expect, it, vi } from 'vitest';
import {
  listLiveTunnelIds,
  listSandboxDNSRecords,
  listSandboxTunnels
} from '../../src/tunnels/inventory';

interface RawTunnel {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface RawDNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  comment?: string | null;
  created_on?: string;
}

function jsonPage(
  body: unknown[],
  page: number,
  totalPages: number,
  perPage = 1000
): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: body,
      result_info: {
        page,
        per_page: perPage,
        total_pages: totalPages,
        count: body.length,
        total_count: body.length
      }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function rawTunnel(overrides: Partial<RawTunnel> = {}): RawTunnel {
  return {
    id: 'tun-id',
    name: 'sandbox-sb-api',
    status: 'healthy',
    created_at: '2026-05-01T00:00:00Z',
    conns_active_at: null,
    conns_inactive_at: null,
    deleted_at: null,
    metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb' },
    ...overrides
  };
}

function rawDNSRecord(overrides: Partial<RawDNSRecord> = {}): RawDNSRecord {
  return {
    id: 'rec-id',
    name: 'api.example.com',
    type: 'CNAME',
    content: 'tun-id.cfargotunnel.com',
    comment: 'sandbox-sb',
    created_on: '2026-05-01T00:00:00Z',
    ...overrides
  };
}

describe('inventory > listSandboxTunnels', () => {
  it('GETs /accounts/:id/cfd_tunnel with live tunnel pagination params', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonPage([], 1, 1));
    await listSandboxTunnels({ token: 'tok', accountId: 'acct' }, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain(
      'https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel'
    );
    expect(String(url)).toContain('is_deleted=false');
    expect(String(url)).toContain('per_page=1000');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('returns SDK-owned tunnels, applies sandbox scoping, and parses dates', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonPage(
        [
          rawTunnel({
            id: 'sb1-tun',
            name: 'sandbox-sb1-api',
            status: 'down',
            conns_active_at: '2026-05-10T12:00:00Z',
            conns_inactive_at: '2026-05-15T08:30:00Z',
            metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb1' }
          }),
          rawTunnel({
            id: 'sb2-tun',
            name: 'sandbox-sb2-api',
            metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb2' }
          }),
          rawTunnel({
            id: 'foreign',
            name: 'other-tool',
            metadata: { createdBy: 'another-tool' }
          }),
          rawTunnel({ id: 'unlabelled', name: 'mystery', metadata: null })
        ],
        1,
        1
      )
    );

    const all = await listSandboxTunnels(
      { token: 'tok', accountId: 'acct' },
      { fetcher }
    );
    expect(all.map((t) => t.id)).toEqual(['sb1-tun', 'sb2-tun']);
    expect(all[0]).toMatchObject({ id: 'sb1-tun', status: 'down' });
    expect(all[0].createdAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(all[0].connsActiveAt?.toISOString()).toBe(
      '2026-05-10T12:00:00.000Z'
    );
    expect(all[0].connsInactiveAt?.toISOString()).toBe(
      '2026-05-15T08:30:00.000Z'
    );

    const scoped = await listSandboxTunnels(
      { token: 'tok', accountId: 'acct' },
      { sandboxId: 'sb1', fetcher }
    );
    expect(scoped.map((t) => t.id)).toEqual(['sb1-tun']);
  });

  it('walks pagination until result_info.page reaches total_pages', async () => {
    let page = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      page += 1;
      expect(String(url)).toContain(`page=${page}`);
      return jsonPage([rawTunnel({ id: `tun-${page}` })], page, 3);
    });

    const result = await listSandboxTunnels(
      { token: 'tok', accountId: 'acct' },
      { fetcher }
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.map((t) => t.id)).toEqual(['tun-1', 'tun-2', 'tun-3']);
  });
});

describe('inventory > listLiveTunnelIds', () => {
  it('returns raw live tunnel ids without SDK metadata filtering', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonPage(
        [
          rawTunnel({ id: 'sdk-tun' }),
          rawTunnel({
            id: 'foreign-live-tun',
            name: 'other',
            metadata: { createdBy: 'another-tool' }
          })
        ],
        1,
        1
      )
    );

    const ids = await listLiveTunnelIds(
      { token: 'tok', accountId: 'acct' },
      { fetcher }
    );
    expect([...ids].sort()).toEqual(['foreign-live-tun', 'sdk-tun']);
  });
});

describe('inventory > listSandboxDNSRecords', () => {
  it('GETs /zones/:id/dns_records with SDK CNAME filter params', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonPage([], 1, 1));
    await listSandboxDNSRecords(
      { token: 'tok', accountId: 'acct', zoneId: 'zone' },
      { fetcher }
    );

    const [url] = fetcher.mock.calls[0];
    expect(String(url)).toContain(
      'https://api.cloudflare.com/client/v4/zones/zone/dns_records'
    );
    expect(String(url)).toContain('type=CNAME');
    expect(String(url)).toContain('comment.startswith=sandbox-');
    expect(String(url)).toContain('per_page=1000');
  });

  it('throws before fetching when zoneId is missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      listSandboxDNSRecords({ token: 'tok', accountId: 'acct' }, { fetcher })
    ).rejects.toThrow(/zoneId/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires the exact SDK marker, applies sandbox scoping, and parses dates', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonPage(
        [
          rawDNSRecord({
            id: 'rec-sb1',
            name: 'a.example.com',
            comment: 'sandbox-sb1'
          }),
          rawDNSRecord({
            id: 'rec-sb2',
            name: 'b.example.com',
            comment: 'sandbox-sb2'
          }),
          rawDNSRecord({ id: 'case-mismatch', comment: 'Sandbox-sb1' })
        ],
        1,
        1
      )
    );

    const all = await listSandboxDNSRecords(
      { token: 'tok', accountId: 'acct', zoneId: 'zone' },
      { fetcher }
    );
    expect(all.map((r) => r.id)).toEqual(['rec-sb1', 'rec-sb2']);
    expect(all[0].createdAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z');

    const scoped = await listSandboxDNSRecords(
      { token: 'tok', accountId: 'acct', zoneId: 'zone' },
      { sandboxId: 'sb1', fetcher }
    );
    expect(scoped.map((r) => r.id)).toEqual(['rec-sb1']);
  });

  it('walks pagination', async () => {
    let page = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      page += 1;
      return jsonPage([rawDNSRecord({ id: `rec-${page}` })], page, 2);
    });

    const result = await listSandboxDNSRecords(
      { token: 'tok', accountId: 'acct', zoneId: 'zone' },
      { fetcher }
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
  });
});
