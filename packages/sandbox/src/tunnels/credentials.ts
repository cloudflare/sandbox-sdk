/**
 * Resolve a Cloudflare account id from environment with documented
 * precedence. Used by features that need to address a specific account
 * (Cloudflare Tunnel, R2 backup) to find their account id without
 * forcing every caller to set the same env var.
 *
 * Precedence (first non-empty wins):
 *   1. The feature-specific override env var (e.g. `CLOUDFLARE_TUNNEL_ACCOUNT_ID`).
 *   2. `CLOUDFLARE_ACCOUNT_ID`.
 *   3. The single account `CLOUDFLARE_API_TOKEN` is scoped to, via
 *      `GET /user/tokens/verify`. Multi-account tokens are rejected.
 *
 * The resolver is feature-agnostic; only the `overrideKey` differs per
 * caller. Throws on any failure with a message that names the env vars
 * the caller can set to fix it.
 */

import { getEnvString } from '@repo/shared';

const TOKEN_VERIFY_URL =
  'https://api.cloudflare.com/client/v4/user/tokens/verify';

export interface ResolveAccountIdOptions {
  /**
   * The feature-specific override env var name. The caller's "preferred"
   * source; checked first.
   */
  overrideKey: 'CLOUDFLARE_TUNNEL_ACCOUNT_ID' | 'CLOUDFLARE_R2_ACCOUNT_ID';
  /**
   * Override the `fetch` implementation for the token-verify call.
   * Defaults to the global `fetch`. Tests inject a mock here.
   */
  fetcher?: typeof fetch;
}

/**
 * Cloudflare's `result_info` shape for `/user/tokens/verify`. The token
 * is "account-scoped" iff `result_info.account.id` is present.
 */
interface TokenVerifyResponse {
  success?: boolean;
  result_info?: {
    account?: { id?: string };
  };
}

export async function resolveAccountId(
  env: Record<string, unknown>,
  options: ResolveAccountIdOptions
): Promise<string> {
  // Step 1: feature-specific override.
  const override = getEnvString(env, options.overrideKey);
  if (override) return override;

  // Step 2: generic account fallback.
  const generic = getEnvString(env, 'CLOUDFLARE_ACCOUNT_ID');
  if (generic) return generic;

  // Step 3: derive from the API token. Requires a token to be present.
  const token = getEnvString(env, 'CLOUDFLARE_API_TOKEN');
  if (!token) {
    throw new Error(
      `Cloudflare account id could not be resolved. Set one of: ` +
        `${options.overrideKey}, CLOUDFLARE_ACCOUNT_ID, or ` +
        `CLOUDFLARE_API_TOKEN (a token scoped to a single account).`
    );
  }

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(TOKEN_VERIFY_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Cloudflare token verification failed with status ${response.status}. ` +
        `Check that CLOUDFLARE_API_TOKEN is valid or set ${options.overrideKey} ` +
        `/ CLOUDFLARE_ACCOUNT_ID explicitly.`
    );
  }

  let body: TokenVerifyResponse;
  try {
    body = (await response.json()) as TokenVerifyResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare token verification returned malformed JSON: ${message}`
    );
  }

  const derived = body?.result_info?.account?.id;
  if (!derived) {
    throw new Error(
      `Cloudflare token is not scoped to a single account (ambiguous). ` +
        `Set ${options.overrideKey} or CLOUDFLARE_ACCOUNT_ID explicitly.`
    );
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Zone id resolution
// ---------------------------------------------------------------------------

const ZONES_LIST_URL = 'https://api.cloudflare.com/client/v4/zones';

export interface ResolveZoneIdOptions {
  /** Cloudflare API token. Must be account- or zone-scoped.*/
  token: string;
  /**
   * Account id the zone must belong to. The resolver scopes the zones
   * list query to this account so a single multi-account token isn't
   * tripped up by zones belonging to a different account.
   */
  accountId: string;
  /**
   * Override the `fetch` implementation for the zones list call.
   * Defaults to the global `fetch`. Tests inject a mock here.
   */
  fetcher?: typeof fetch;
}

interface ZonesListResponse {
  success?: boolean;
  result?: Array<{ id?: string; name?: string }>;
  errors?: Array<{ code?: number; message?: string }>;
}

/**
 * Resolve a Cloudflare zone id.
 *
 * Precedence:
 *   1. `CLOUDFLARE_ZONE_ID` env var.
 *   2. The single zone the token can see under `accountId`, via
 *      `GET /zones?account.id=<accountId>&per_page=2`.
 *
 * Step 2 deliberately fetches at most two results: one is the happy path,
 * two (or more) means the token is ambiguous and we refuse to guess.
 * Multi-zone tokens must set `CLOUDFLARE_ZONE_ID` explicitly so the
 * caller's intent is unambiguous.
 */
export async function resolveZoneId(
  env: Record<string, unknown>,
  options: ResolveZoneIdOptions
): Promise<string> {
  const envZone = getEnvString(env, 'CLOUDFLARE_ZONE_ID');
  if (envZone) return envZone;

  const fetcher = options.fetcher ?? fetch;
  const url = `${ZONES_LIST_URL}?account.id=${encodeURIComponent(options.accountId)}&per_page=2`;
  const response = await fetcher(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Cloudflare zones lookup failed with status ${response.status}. ` +
        'Set CLOUDFLARE_ZONE_ID explicitly or grant the API token Zone:Read.'
    );
  }

  let body: ZonesListResponse;
  try {
    body = (await response.json()) as ZonesListResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare zones lookup returned malformed JSON: ${message}`
    );
  }

  const zones = body.result ?? [];
  if (zones.length === 0) {
    throw new Error(
      'Cloudflare API token has access to no zones in account ' +
        `${options.accountId}. Set CLOUDFLARE_ZONE_ID explicitly or ` +
        'grant the token Zone:Read on the intended zone.'
    );
  }
  if (zones.length > 1) {
    throw new Error(
      'Cloudflare API token has access to multiple zones in account ' +
        `${options.accountId} (ambiguous). Set CLOUDFLARE_ZONE_ID ` +
        'explicitly to disambiguate.'
    );
  }
  const zoneId = zones[0]?.id;
  if (!zoneId) {
    throw new Error(
      'Cloudflare zones lookup returned a result without an id field.'
    );
  }
  return zoneId;
}
