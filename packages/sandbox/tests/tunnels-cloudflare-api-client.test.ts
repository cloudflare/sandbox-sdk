/**
 * `cf-api.ts` unit tests.
 *
 * All five helpers (`createTunnel`, `upsertDNSRecord`, `deleteDNSRecord`,
 * `deleteTunnel`, `getZoneName`) are thin wrappers around `fetch` calls
 * to the Cloudflare REST API. We mock fetch and assert:
 *
 *   - the right URL + method + body shape goes out
 *   - successes are extracted from `result`
 *   - failures throw with the API errors surfaced
 *   - tagging metadata makes it onto the wire
 *   - upsertDNSRecord is idempotent on identical existing records,
 *     refuses to overwrite mismatched ones, and falls back without
 *     `tags` on 4xx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CloudflareCredentials,
  createTunnel,
  deleteDNSRecord,
  deleteTunnel,
  getZoneName,
  upsertDNSRecord
} from '../src/tunnels/cloudflare-api-client';

const creds: CloudflareCredentials = {
  apiToken: 'cfat_test_token',
  accountId: 'acct-uuid',
  zoneId: 'zone-uuid'
};

interface MockCall {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

const calls: MockCall[] = [];

function mockResponse(
  body: unknown,
  init: { status?: number; ok?: boolean } = {}
): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

let queue: Array<() => Response | Promise<Response>> = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  calls.length = 0;
  queue = [];
  originalFetch = global.fetch;
  global.fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers: Record<string, string> = {};
      const initHeaders = init.headers as Record<string, string> | undefined;
      if (initHeaders) Object.assign(headers, initHeaders);
      let parsedBody: unknown;
      if (typeof init.body === 'string') {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: parsedBody,
        headers
      });

      const next = queue.shift();
      if (!next) {
        throw new Error(
          `Unexpected fetch call: ${init.method ?? 'GET'} ${url}`
        );
      }
      return next();
    }
  ) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------

describe('createTunnel', () => {
  it('POSTs to /accounts/:id/cfd_tunnel with sandbox-tagged metadata', async () => {
    queue.push(() =>
      mockResponse({
        success: true,
        result: {
          id: 'tunnel-uuid-1',
          token: 'opaque-token'
        },
        errors: []
      })
    );

    const result = await createTunnel(creds, { sandboxId: 'sb-123' });

    expect(result).toEqual({
      id: 'tunnel-uuid-1',
      token: 'opaque-token',
      cnameTarget: 'tunnel-uuid-1.cfargotunnel.com'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-uuid/cfd_tunnel'
    );
    expect(calls[0].headers.Authorization).toBe('Bearer cfat_test_token');

    const body = calls[0].body as {
      name: string;
      config_src: string;
      metadata: Record<string, unknown>;
    };
    expect(body.config_src).toBe('cloudflare');
    expect(body.metadata.createdBy).toBe('sandbox-sdk');
    expect(body.metadata.sandboxId).toBe('sb-123');
    expect(typeof body.name).toBe('string');
    expect(body.name).toMatch(/^sandbox-sb-123-/);
  });

  it('respects an explicit tunnelLabel override', async () => {
    queue.push(() =>
      mockResponse({
        success: true,
        result: { id: 'id', token: 'tok' }
      })
    );

    await createTunnel(creds, {
      sandboxId: 'sb',
      tunnelLabel: 'my-custom-name'
    });

    const body = calls[0].body as { name: string };
    expect(body.name).toBe('my-custom-name');
  });

  it('throws with the API error message on failure', async () => {
    queue.push(() =>
      mockResponse(
        {
          success: false,
          errors: [{ code: 1003, message: 'Invalid request' }]
        },
        { status: 400 }
      )
    );

    await expect(createTunnel(creds, { sandboxId: 'sb' })).rejects.toThrow(
      /1003: Invalid request/
    );
  });
});

describe('getZoneName', () => {
  it('returns the zone name from /zones/:id', async () => {
    queue.push(() =>
      mockResponse({
        success: true,
        result: { name: 'example.com', status: 'active' }
      })
    );

    const name = await getZoneName(creds);
    expect(name).toBe('example.com');
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-uuid'
    );
    expect(calls[0].method).toBe('GET');
  });
});

describe('upsertDNSRecord', () => {
  it('creates a new CNAME with proxied=true and a sandbox-tagged comment', async () => {
    queue.push(() =>
      mockResponse({
        success: true,
        result: [] // GET ?name= returns no existing records
      })
    );
    queue.push(() =>
      mockResponse({
        success: true,
        result: { id: 'dns-rec-1', name: 'preview.example.com' }
      })
    );

    const result = await upsertDNSRecord(creds, {
      hostname: 'preview.example.com',
      cnameTarget: 'tunnel-uuid-1.cfargotunnel.com',
      sandboxId: 'sb-abc'
    });

    expect(result).toEqual({
      recordId: 'dns-rec-1',
      hostname: 'preview.example.com'
    });

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('?name=preview.example.com');

    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-uuid/dns_records'
    );
    const body = calls[1].body as {
      type: string;
      name: string;
      content: string;
      proxied: boolean;
      comment: string;
      tags?: string[];
    };
    expect(body.type).toBe('CNAME');
    expect(body.name).toBe('preview.example.com');
    expect(body.content).toBe('tunnel-uuid-1.cfargotunnel.com');
    expect(body.proxied).toBe(true);
    expect(body.comment).toBe('sandbox-sb-abc');
    // First attempt includes `tags` (best-effort, EE-only).
    expect(body.tags).toEqual(['sandbox-sdk', 'sandbox-sb-abc']);
  });

  it('reuses an existing record with the right CNAME content (idempotent)', async () => {
    queue.push(() =>
      mockResponse({
        success: true,
        result: [
          {
            id: 'existing-dns',
            type: 'CNAME',
            content: 'tunnel-uuid-1.cfargotunnel.com',
            name: 'preview.example.com'
          }
        ]
      })
    );

    const result = await upsertDNSRecord(creds, {
      hostname: 'preview.example.com',
      cnameTarget: 'tunnel-uuid-1.cfargotunnel.com',
      sandboxId: 'sb-abc'
    });

    expect(result.recordId).toBe('existing-dns');
    // Only the GET was made — no POST, because the record already exists.
    expect(calls).toHaveLength(1);
  });

  it('refuses to overwrite a record pointing somewhere else', async () => {
    queue.push(() =>
      mockResponse({
        success: true,
        result: [
          {
            id: 'apex-a-record',
            type: 'A',
            content: '104.21.83.139',
            name: 'preview.example.com'
          }
        ]
      })
    );

    await expect(
      upsertDNSRecord(creds, {
        hostname: 'preview.example.com',
        cnameTarget: 'tunnel-uuid-1.cfargotunnel.com',
        sandboxId: 'sb-abc'
      })
    ).rejects.toThrow(/already exists with different content/);
    expect(calls).toHaveLength(1);
  });

  it('retries POST without `tags` when the first attempt 4xxs', async () => {
    queue.push(() => mockResponse({ success: true, result: [] }));
    // First POST (with tags) fails with a 4xx — Free plan rejects tags.
    queue.push(() =>
      mockResponse(
        {
          success: false,
          errors: [{ code: 9007, message: 'tags not allowed' }]
        },
        { status: 400 }
      )
    );
    // Retry without tags succeeds.
    queue.push(() =>
      mockResponse({
        success: true,
        result: { id: 'dns-rec-no-tags', name: 'preview.example.com' }
      })
    );

    const result = await upsertDNSRecord(creds, {
      hostname: 'preview.example.com',
      cnameTarget: 'tunnel-uuid-1.cfargotunnel.com',
      sandboxId: 'sb-abc'
    });

    expect(result.recordId).toBe('dns-rec-no-tags');
    expect(calls).toHaveLength(3);
    const firstPostBody = calls[1].body as { tags?: string[] };
    const retryBody = calls[2].body as { tags?: string[] };
    expect(firstPostBody.tags).toEqual(['sandbox-sdk', 'sandbox-sb-abc']);
    expect(retryBody.tags).toBeUndefined();
  });
});

describe('deleteDNSRecord & deleteTunnel', () => {
  it('deleteDNSRecord issues DELETE on /zones/:id/dns_records/:rid', async () => {
    queue.push(() => mockResponse({ success: true, result: { id: 'rec-id' } }));

    await deleteDNSRecord(creds, 'rec-id');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-uuid/dns_records/rec-id'
    );
  });

  it('deleteTunnel issues DELETE on /accounts/:id/cfd_tunnel/:tid', async () => {
    queue.push(() => mockResponse({ success: true, result: { id: 'tun-id' } }));

    await deleteTunnel(creds, 'tun-id');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-uuid/cfd_tunnel/tun-id'
    );
  });
});
