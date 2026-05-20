/**
 * Unit tests for the Cloudflare account-id resolver.
 *
 * The resolver picks an account id with documented precedence:
 *   1. The feature-specific override env var
 *      (`CLOUDFLARE_TUNNEL_ACCOUNT_ID` or `CLOUDFLARE_R2_ACCOUNT_ID`).
 *   2. `CLOUDFLARE_ACCOUNT_ID`.
 *   3. The account scoped to `CLOUDFLARE_API_TOKEN`, as returned by
 *      `GET /user/tokens/verify`.
 *
 * Steps 1 and 2 are purely env-string reads; step 3 hits the Cloudflare
 * API, which we mock here. Multi-account tokens are rejected with a
 * dedicated error code so callers can distinguish "missing config" from
 * "ambiguous config".
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveAccountId, resolveZoneId } from '../../src/tunnels/credentials';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * Build a fetcher mock that routes by URL substring. Reused by the
 * multi-step account-token tests where the resolver hits more than one
 * endpoint (`/user/tokens/verify` → `/accounts` → `/accounts/:id/tokens/verify`)
 * and each needs a different canned response.
 *
 * Routes are matched longest-substring-first so '/accounts/acct-1/tokens/verify'
 * wins over '/accounts' when both are registered.
 */
function routedFetcher(routes: Record<string, Response>) {
  const ordered = Object.entries(routes).sort(
    ([a], [b]) => b.length - a.length
  );
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [match, response] of ordered) {
      if (url.includes(match)) return response.clone();
    }
    return new Response(`No mock route for ${url}`, { status: 599 });
  });
}

describe('resolveAccountId', () => {
  describe('precedence', () => {
    it('returns the override env var when present', async () => {
      const fetcher = vi.fn();
      const id = await resolveAccountId(
        {
          CLOUDFLARE_TUNNEL_ACCOUNT_ID: 'override-acct',
          CLOUDFLARE_ACCOUNT_ID: 'fallback-acct',
          CLOUDFLARE_API_TOKEN: 'tok'
        },
        { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
      );
      expect(id).toBe('override-acct');
      // Override hit means no fallback consulted.
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('falls back to CLOUDFLARE_ACCOUNT_ID when override is absent', async () => {
      const fetcher = vi.fn();
      const id = await resolveAccountId(
        {
          CLOUDFLARE_ACCOUNT_ID: 'fallback-acct',
          CLOUDFLARE_API_TOKEN: 'tok'
        },
        { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
      );
      expect(id).toBe('fallback-acct');
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('verifies the token when neither override nor account env is set', async () => {
      const fetcher = vi.fn(async () =>
        jsonResponse({
          success: true,
          result: { id: 'tok-id', status: 'active' },
          result_info: { account: { id: 'token-derived-acct' } }
        })
      );
      const id = await resolveAccountId(
        { CLOUDFLARE_API_TOKEN: 'sekret' },
        { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
      );
      expect(id).toBe('token-derived-acct');
      // The verify endpoint was called exactly once with the token in the header.
      expect(fetcher).toHaveBeenCalledTimes(1);
      const call = fetcher.mock.calls[0];
      expect(String(call[0])).toContain('/user/tokens/verify');
      const headers = new Headers((call[1] as RequestInit)?.headers);
      expect(headers.get('authorization')).toBe('Bearer sekret');
    });

    it('uses the override even if it is the empty string in falsy-fallback semantics — empty is treated as unset', async () => {
      // Empty string from a missing-but-defined env var should NOT short-circuit
      // the precedence chain. Otherwise a stray "" in Worker config would
      // silently win over CLOUDFLARE_ACCOUNT_ID.
      const fetcher = vi.fn();
      const id = await resolveAccountId(
        {
          CLOUDFLARE_TUNNEL_ACCOUNT_ID: '',
          CLOUDFLARE_ACCOUNT_ID: 'fallback-acct',
          CLOUDFLARE_API_TOKEN: 'tok'
        },
        { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
      );
      expect(id).toBe('fallback-acct');
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it('throws when token is missing and no account env is set', async () => {
      const fetcher = vi.fn();
      await expect(
        resolveAccountId(
          {},
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('throws with a clear message naming every missing var', async () => {
      const fetcher = vi.fn();
      try {
        await resolveAccountId(
          {},
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        );
        throw new Error('should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        // Names BOTH the override and the fallback, so callers know any
        // single one would resolve the precedence.
        expect(message).toContain('CLOUDFLARE_TUNNEL_ACCOUNT_ID');
        expect(message).toContain('CLOUDFLARE_ACCOUNT_ID');
        expect(message).toContain('CLOUDFLARE_API_TOKEN');
      }
    });

    it('throws when the token-verify response is not 200', async () => {
      const fetcher = vi.fn(async () =>
        jsonResponse({ success: false, errors: [{ code: 9109 }] }, 401)
      );
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'bad' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/token/i);
    });

    it('throws when token-verify succeeds but the token is not scoped to an account', async () => {
      // result_info.account.id missing means the token has user-scoped
      // permissions only and cannot identify a single account.
      const fetcher = vi.fn(async () =>
        jsonResponse({ success: true, result: { status: 'active' } })
      );
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'tok' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/ambiguous|account/i);
    });

    it('throws when the verify response is malformed JSON', async () => {
      const fetcher = vi.fn(
        async () => new Response('not json', { status: 200 })
      );
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'tok' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow();
    });

    it('throws on 401 with code 1000 (account-owned token) when /accounts is not authorized', async () => {
      // Reproduces the cfat- token shape we saw in the wild: /user/tokens/verify
      // returns 1000 (account-owned token), and /accounts returns 9109
      // because the token wasn't granted account:read.
      const fetcher = routedFetcher({
        '/user/tokens/verify': jsonResponse(
          { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] },
          401
        ),
        '/accounts': jsonResponse(
          { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] },
          403
        )
      });
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'cfat-xxx' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID|account-owned/i);
    });
  });

  describe('account-owned (cfat-) tokens', () => {
    it('falls through to /accounts on 1000, picks single match, confirms via /accounts/:id/tokens/verify', async () => {
      const fetcher = routedFetcher({
        '/user/tokens/verify': jsonResponse(
          { success: false, errors: [{ code: 1000 }] },
          401
        ),
        '/accounts': jsonResponse({
          success: true,
          result: [{ id: 'acct-cfat-1', name: 'My Account' }]
        }),
        '/accounts/acct-cfat-1/tokens/verify': jsonResponse({
          success: true,
          result: { id: 'tok-id', status: 'active' }
        })
      });

      const id = await resolveAccountId(
        { CLOUDFLARE_API_TOKEN: 'cfat-xxx' },
        { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
      );
      expect(id).toBe('acct-cfat-1');
      // All three endpoints were called exactly once, in order.
      const urls = fetcher.mock.calls.map((c) => String(c[0]));
      expect(urls).toEqual([
        expect.stringContaining('/user/tokens/verify'),
        expect.stringContaining('/accounts?'),
        expect.stringContaining('/accounts/acct-cfat-1/tokens/verify')
      ]);
      // The /accounts probe uses per_page=2 to detect ambiguity cheaply.
      expect(urls[1]).toContain('per_page=2');
    });

    it('throws when /accounts returns multiple accounts (ambiguous)', async () => {
      const fetcher = routedFetcher({
        '/user/tokens/verify': jsonResponse(
          { success: false, errors: [{ code: 1000 }] },
          401
        ),
        '/accounts': jsonResponse({
          success: true,
          result: [
            { id: 'acct-a' },
            { id: 'acct-b' }
          ]
        })
      });
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'cfat-xxx' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/multiple|ambiguous|CLOUDFLARE_ACCOUNT_ID/i);
    });

    it('throws when /accounts returns zero accounts', async () => {
      const fetcher = routedFetcher({
        '/user/tokens/verify': jsonResponse(
          { success: false, errors: [{ code: 1000 }] },
          401
        ),
        '/accounts': jsonResponse({ success: true, result: [] })
      });
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'cfat-xxx' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/no accounts|CLOUDFLARE_ACCOUNT_ID/i);
    });

    it('throws when /accounts/:id/tokens/verify rejects the inferred id', async () => {
      const fetcher = routedFetcher({
        '/user/tokens/verify': jsonResponse(
          { success: false, errors: [{ code: 1000 }] },
          401
        ),
        '/accounts': jsonResponse({
          success: true,
          result: [{ id: 'acct-1' }]
        }),
        '/accounts/acct-1/tokens/verify': jsonResponse(
          { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] },
          401
        )
      });
      await expect(
        resolveAccountId(
          { CLOUDFLARE_API_TOKEN: 'cfat-xxx' },
          { overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID', fetcher }
        )
      ).rejects.toThrow(/verify|invalid/i);
    });
  });

  describe('reuse', () => {
    it('works identically for the R2 override key', async () => {
      // The resolver is feature-agnostic; only the override env key changes.
      const fetcher = vi.fn();
      const id = await resolveAccountId(
        {
          CLOUDFLARE_R2_ACCOUNT_ID: 'r2-override',
          CLOUDFLARE_ACCOUNT_ID: 'fallback'
        },
        { overrideKey: 'CLOUDFLARE_R2_ACCOUNT_ID', fetcher }
      );
      expect(id).toBe('r2-override');
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});

describe('resolveZoneId', () => {
  it('returns CLOUDFLARE_ZONE_ID when set', async () => {
    const fetcher = vi.fn();
    const id = await resolveZoneId(
      { CLOUDFLARE_ZONE_ID: 'env-zone' },
      { token: 'tok', accountId: 'acct', fetcher }
    );
    expect(id).toBe('env-zone');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('queries the zones API when the env var is missing and returns the single match', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: [{ id: 'token-zone', name: 'example.com' }]
      })
    );
    const id = await resolveZoneId(
      {},
      { token: 'sekret', accountId: 'acct-123', fetcher }
    );
    expect(id).toBe('token-zone');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    // Scoped to the resolved account so multi-tenant tokens see only the
    // account at hand.
    expect(String(url)).toContain('/zones');
    expect(String(url)).toContain('account.id=acct-123');
    // per_page=2 is enough to detect ambiguity without paging.
    expect(String(url)).toContain('per_page=2');
    const headers = new Headers((init as RequestInit)?.headers);
    expect(headers.get('authorization')).toBe('Bearer sekret');
  });

  it('treats empty CLOUDFLARE_ZONE_ID as unset', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: [{ id: 'token-zone', name: 'example.com' }]
      })
    );
    const id = await resolveZoneId(
      { CLOUDFLARE_ZONE_ID: '' },
      { token: 'tok', accountId: 'acct', fetcher }
    );
    expect(id).toBe('token-zone');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws when the token has access to no zones in the account', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ success: true, result: [] })
    );
    await expect(
      resolveZoneId({}, { token: 'tok', accountId: 'acct', fetcher })
    ).rejects.toThrow(/no zones|CLOUDFLARE_ZONE_ID/i);
  });

  it('throws when the token has access to multiple zones', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        success: true,
        result: [
          { id: 'zone-a', name: 'a.example.com' },
          { id: 'zone-b', name: 'b.example.com' }
        ]
      })
    );
    await expect(
      resolveZoneId({}, { token: 'tok', accountId: 'acct', fetcher })
    ).rejects.toThrow(/multiple|ambiguous|CLOUDFLARE_ZONE_ID/i);
  });

  it('throws when the zones API responds with a non-2xx', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { success: false, errors: [{ code: 9109 }] },
        403
      )
    );
    await expect(
      resolveZoneId({}, { token: 'tok', accountId: 'acct', fetcher })
    ).rejects.toThrow();
  });
});
