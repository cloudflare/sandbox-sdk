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
import { resolveAccountId } from '../../src/tunnels/credentials';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
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
