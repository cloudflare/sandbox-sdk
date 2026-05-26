/**
 * Unit tests for the Cloudflare API client used by named tunnels.
 *
 * Every function is a thin wrapper over a single Cloudflare API
 * endpoint. The tests assert:
 *   - the request method, URL, headers, and body shape
 *   - the parsed return value shape
 *   - structured error behaviour (HTTP errors, API `success: false`,
 *     and the special "already exists with different content" branch).
 *
 * `fetch` is mocked via the `fetcher` injection on each call.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createTunnel,
  deleteDNSRecord,
  deleteTunnel,
  findTunnelByName,
  getTunnelToken,
  getZoneName,
  upsertCNAME
} from '../../src/tunnels/cloudflare-api';

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function jsonError(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('cloudflare-api > createTunnel', () => {
  it('POSTs to /accounts/:id/cfd_tunnel with config_src and metadata', async () => {
    const fetcher = vi.fn(async () =>
      jsonOk({ id: 'tun-uuid', token: 'OPAQUE_TOKEN', account_tag: 'acct' })
    );
    const result = await createTunnel({
      token: 'tok',
      accountId: 'acct-id',
      tunnelName: 'sandbox-sb1-api',
      metadata: {
        sandboxId: 'sb1',
        createdBy: 'sandbox-sdk',
        name: 'api',
        port: 8080
      },
      fetcher
    });

    expect(result.id).toBe('tun-uuid');
    expect(result.token).toBe('OPAQUE_TOKEN');

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-id/cfd_tunnel'
    );
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(init?.body));
    expect(body.name).toBe('sandbox-sb1-api');
    expect(body.config_src).toBe('cloudflare');
    expect(body.metadata).toEqual({
      sandboxId: 'sb1',
      createdBy: 'sandbox-sdk',
      name: 'api',
      port: 8080
    });
  });

  it('throws when the API returns success: false', async () => {
    const fetcher = vi.fn(async () =>
      jsonError({ success: false, errors: [{ code: 1004, message: 'bad' }] })
    );
    await expect(
      createTunnel({
        token: 'tok',
        accountId: 'acct-id',
        tunnelName: 'x',
        metadata: {
          sandboxId: 'sb',
          createdBy: 'sandbox-sdk',
          name: 'n',
          port: 1
        },
        fetcher
      })
    ).rejects.toThrow(/1004|bad/i);
  });

  it('throws on transport-level errors with a clear message', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      createTunnel({
        token: 'tok',
        accountId: 'acct',
        tunnelName: 'x',
        metadata: {
          sandboxId: 's',
          createdBy: 'sandbox-sdk',
          name: 'n',
          port: 1
        },
        fetcher
      })
    ).rejects.toThrow(/ECONNRESET/);
  });
});

describe('cloudflare-api > findTunnelByName', () => {
  it('returns the first non-deleted tunnel with a matching name', async () => {
    const fetcher = vi.fn(async () =>
      jsonOk([
        {
          id: 'old',
          name: 'sandbox-sb-api',
          deleted_at: '2026-01-01T00:00:00Z'
        },
        { id: 'live', name: 'sandbox-sb-api', deleted_at: null }
      ])
    );
    const found = await findTunnelByName({
      token: 'tok',
      accountId: 'acct',
      tunnelName: 'sandbox-sb-api',
      fetcher
    });
    expect(found?.id).toBe('live');

    const [url] = fetcher.mock.calls[0];
    expect(String(url)).toContain(
      '/accounts/acct/cfd_tunnel?name=sandbox-sb-api'
    );
    // is_deleted=false hints the API at returning only live records; the
    // client filters defensively in case the API doesn't honour it.
    expect(String(url)).toContain('is_deleted=false');
  });

  it('returns null when no tunnel matches', async () => {
    const fetcher = vi.fn(async () => jsonOk([]));
    const found = await findTunnelByName({
      token: 'tok',
      accountId: 'acct',
      tunnelName: 'sandbox-sb-missing',
      fetcher
    });
    expect(found).toBeNull();
  });

  it('treats all-deleted matches as null', async () => {
    const fetcher = vi.fn(async () =>
      jsonOk([{ id: 't', name: 'x', deleted_at: '2026-01-01T00:00:00Z' }])
    );
    const found = await findTunnelByName({
      token: 'tok',
      accountId: 'acct',
      tunnelName: 'x',
      fetcher
    });
    expect(found).toBeNull();
  });

  it('treats a name match with mismatching metadata.sandboxId as null when expectedSandboxId is set', async () => {
    // Defensive: tunnel name encodes <sandboxId>-<name>, but a malicious
    // or buggy caller could construct a tunnel with the same name under
    // a different sandbox. The metadata tag is the authoritative
    // "created by this sandbox" check, and the docstring promises
    // reconciliation uses it — so when expectedSandboxId is passed and
    // the metadata disagrees, refuse to claim the tunnel.
    const fetcher = vi.fn(async () =>
      jsonOk([
        {
          id: 'foreign',
          name: 'sandbox-sb-api',
          deleted_at: null,
          metadata: { sandboxId: 'other-sandbox', createdBy: 'sandbox-sdk' }
        }
      ])
    );
    const found = await findTunnelByName({
      token: 'tok',
      accountId: 'acct',
      tunnelName: 'sandbox-sb-api',
      expectedSandboxId: 'sb',
      fetcher
    });
    expect(found).toBeNull();
  });

  it('returns the tunnel when metadata.sandboxId matches expectedSandboxId', async () => {
    const fetcher = vi.fn(async () =>
      jsonOk([
        {
          id: 'ours',
          name: 'sandbox-sb-api',
          deleted_at: null,
          metadata: { sandboxId: 'sb', createdBy: 'sandbox-sdk' }
        }
      ])
    );
    const found = await findTunnelByName({
      token: 'tok',
      accountId: 'acct',
      tunnelName: 'sandbox-sb-api',
      expectedSandboxId: 'sb',
      fetcher
    });
    expect(found?.id).toBe('ours');
  });
});

describe('cloudflare-api > deleteTunnel', () => {
  it('DELETEs the tunnel resource and resolves on 200', async () => {
    const fetcher = vi.fn(async () => jsonOk({ id: 'tun-uuid' }));
    await deleteTunnel({
      token: 'tok',
      accountId: 'acct',
      tunnelId: 'tun-uuid',
      fetcher
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel/tun-uuid'
    );
    expect(init?.method).toBe('DELETE');
  });

  it('treats 404 as a successful (already-gone) outcome', async () => {
    const fetcher = vi.fn(async () =>
      jsonError({ success: false, errors: [{ code: 1003 }] }, 404)
    );
    await expect(
      deleteTunnel({
        token: 'tok',
        accountId: 'acct',
        tunnelId: 'tun-uuid',
        fetcher
      })
    ).resolves.toBeUndefined();
  });

  it('throws on other API failures', async () => {
    const fetcher = vi.fn(async () =>
      jsonError(
        { success: false, errors: [{ code: 1006, message: 'forbidden' }] },
        403
      )
    );
    await expect(
      deleteTunnel({
        token: 'tok',
        accountId: 'acct',
        tunnelId: 'tun-uuid',
        fetcher
      })
    ).rejects.toThrow(/1006|forbidden/i);
  });
});

describe('cloudflare-api > getZoneName', () => {
  it('returns the zone name for a given zone id', async () => {
    const fetcher = vi.fn(async () =>
      jsonOk({ id: 'zone-id', name: 'example.com' })
    );
    const name = await getZoneName({
      token: 'tok',
      zoneId: 'zone-id',
      fetcher
    });
    expect(name).toBe('example.com');
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-id'
    );
  });

  it('throws when the zone fetch fails', async () => {
    const fetcher = vi.fn(async () =>
      jsonError({ success: false, errors: [{ code: 7003 }] }, 404)
    );
    await expect(
      getZoneName({ token: 'tok', zoneId: 'bad', fetcher })
    ).rejects.toThrow(/7003|zone/i);
  });
});

describe('cloudflare-api > upsertCNAME', () => {
  const baseArgs = {
    token: 'tok',
    zoneId: 'zone-id',
    hostname: 'api.example.com',
    cnameTarget: 'tun-uuid.cfargotunnel.com',
    comment: 'sandbox-sb1',
    fetcher: vi.fn()
  };

  it('creates a proxied CNAME when no record exists', async () => {
    const fetcher = vi
      .fn()
      // list -> empty
      .mockResolvedValueOnce(jsonOk([]))
      // create -> ok
      .mockResolvedValueOnce(jsonOk({ id: 'dns-id' }));
    const result = await upsertCNAME({ ...baseArgs, fetcher });
    expect(result.recordId).toBe('dns-id');
    expect(result.reused).toBe(false);

    // List call
    const [listUrl, listInit] = fetcher.mock.calls[0];
    expect(String(listUrl)).toContain('/zones/zone-id/dns_records');
    expect(String(listUrl)).toContain('name=api.example.com');
    expect(String(listUrl)).toContain('type=CNAME');
    expect(listInit?.method ?? 'GET').toBe('GET');

    // Create call
    const [createUrl, createInit] = fetcher.mock.calls[1];
    expect(String(createUrl)).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records'
    );
    expect(createInit?.method).toBe('POST');
    const body = JSON.parse(String(createInit?.body));
    expect(body.type).toBe('CNAME');
    expect(body.name).toBe('api.example.com');
    expect(body.content).toBe('tun-uuid.cfargotunnel.com');
    expect(body.proxied).toBe(true);
    expect(body.comment).toBe('sandbox-sb1');
  });

  it('reuses an existing record when content + comment match', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonOk([
        {
          id: 'dns-id',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'tun-uuid.cfargotunnel.com',
          comment: 'sandbox-sb1',
          proxied: true
        }
      ])
    );
    const result = await upsertCNAME({ ...baseArgs, fetcher });
    expect(result.recordId).toBe('dns-id');
    expect(result.reused).toBe(true);
    // Only the list call \u2014 no POST/PUT was made.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing record when content matches even if comment has drifted', async () => {
    // The CNAME content `<tunnel-id>.cfargotunnel.com` is the
    // authoritative "this record points at our tunnel" check — only
    // the holder of the tunnel id could have created it. The comment
    // is free text that operators commonly edit through the dashboard,
    // so treating it as a structural key was too fragile.
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonOk([
        {
          id: 'dns-id',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'tun-uuid.cfargotunnel.com',
          // Operator edited the comment from the dashboard.
          comment: 'sandbox-sb1 (renamed by ops)',
          proxied: true
        }
      ])
    );
    const result = await upsertCNAME({ ...baseArgs, fetcher });
    expect(result.recordId).toBe('dns-id');
    expect(result.reused).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws when an existing record points to different content', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonOk([
        {
          id: 'other-dns',
          type: 'CNAME',
          name: 'api.example.com',
          content: 'other-tunnel.cfargotunnel.com',
          comment: 'someone-else',
          proxied: true
        }
      ])
    );
    await expect(upsertCNAME({ ...baseArgs, fetcher })).rejects.toThrow(
      /already exists|owned/i
    );
    // The throw must not be followed by any mutation.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('cloudflare-api > deleteDNSRecord', () => {
  it('DELETEs the dns record id', async () => {
    const fetcher = vi.fn(async () => jsonOk({ id: 'dns-id' }));
    await deleteDNSRecord({
      token: 'tok',
      zoneId: 'zone-id',
      recordId: 'dns-id',
      fetcher
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records/dns-id'
    );
    expect(init?.method).toBe('DELETE');
  });

  it('treats 404 as success', async () => {
    const fetcher = vi.fn(async () =>
      jsonError({ success: false, errors: [{ code: 81044 }] }, 404)
    );
    await expect(
      deleteDNSRecord({
        token: 'tok',
        zoneId: 'zone-id',
        recordId: 'missing',
        fetcher
      })
    ).resolves.toBeUndefined();
  });
});

describe('cloudflare-api > getTunnelToken', () => {
  it('returns the token string from the API envelope', async () => {
    const fetcher = vi.fn(async () => jsonOk('OPAQUE_TOKEN_VALUE'));
    const token = await getTunnelToken({
      token: 'tok',
      accountId: 'acct',
      tunnelId: 'tun-uuid',
      fetcher
    });
    expect(token).toBe('OPAQUE_TOKEN_VALUE');
    const [url] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel/tun-uuid/token'
    );
  });

  it('throws when the envelope is missing a string token', async () => {
    const fetcher = vi.fn(async () => jsonOk(null));
    await expect(
      getTunnelToken({
        token: 'tok',
        accountId: 'acct',
        tunnelId: 'tun-uuid',
        fetcher
      })
    ).rejects.toThrow(/did not return a token/i);
  });
});

describe('cloudflare-api > request timeout', () => {
  it('translates a TimeoutError from fetch into a labelled timeout error', async () => {
    // The wrapper attaches `signal: AbortSignal.timeout(...)` to every
    // request and translates the resulting `TimeoutError` into a clear
    // message. Simulate that by rejecting the fetch synchronously with
    // a TimeoutError-shaped error so the assertion runs instantly
    // instead of waiting on the real 10s timer.
    const fetcher = vi.fn(async () => {
      const err = new Error('signal timed out');
      err.name = 'TimeoutError';
      throw err;
    });

    await expect(
      getZoneName({
        token: 'tok',
        zoneId: 'zone-uuid',
        fetcher: fetcher as unknown as typeof fetch
      })
    ).rejects.toThrow(/timed out after \d+ms/);
  });

  it('attaches an AbortSignal to every request', async () => {
    let observedSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      observedSignal = init?.signal;
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: 'z', name: 'example.com' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    await getZoneName({
      token: 'tok',
      zoneId: 'zone-uuid',
      fetcher: fetcher as unknown as typeof fetch
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });
});
