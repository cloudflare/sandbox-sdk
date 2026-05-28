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
const ACCOUNTS_LIST_URL = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Per-request timeout for the credential introspection calls below.
 * Without one a hung Cloudflare control-plane call wedges every
 * first-time named-tunnel `get()` on the DO (the resolver promises are
 * memoised on `Sandbox`, so the first caller's hang is everyone's hang).
 */
const CREDENTIALS_TIMEOUT_MS = 10_000;

/**
 * Fetch wrapper that adds an `AbortSignal.timeout` and surfaces a
 * timeout as a labelled `Error` so the caller can blame the right URL.
 */
async function fetchWithTimeout(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = CREDENTIALS_TIMEOUT_MS
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Cloudflare API request to ${url} timed out after ${timeoutMs}ms`
      );
    }
    throw err;
  }
}

/**
 * Cloudflare error code returned by `GET /user/tokens/verify` when the
 * presented token is an account-owned (`cfat-`) token rather than a
 * user-owned one. Matches the heuristic wrangler uses in
 * `src/user/whoami.ts` (`getTokenType`).
 */
const ACCOUNT_OWNED_TOKEN_CODE = 1000;

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
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: {
    account?: { id?: string };
  };
}

interface AccountsListResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: Array<{ id?: string; name?: string }>;
}

interface AccountTokenVerifyResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: { id?: string; status?: string };
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
  const response = await fetchWithTimeout(fetcher, TOKEN_VERIFY_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  });

  // Drain the body whether we succeed or not so the caller-facing error
  // can report the API error code (e.g. 1000 = account-owned token).
  let body: TokenVerifyResponse;
  try {
    body = (await response.json()) as TokenVerifyResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare token verification returned malformed JSON: ${message}`
    );
  }

  if (response.ok && body?.success) {
    const derived = body.result_info?.account?.id;
    if (!derived) {
      throw new Error(
        'Cloudflare token is not scoped to a single account (ambiguous). ' +
          `Set ${options.overrideKey} or CLOUDFLARE_ACCOUNT_ID explicitly.`
      );
    }
    return derived;
  }

  // Wrangler's `getTokenType` uses the same heuristic: code 1000 on
  // `/user/tokens/verify` means the token is account-owned (cfat-...)
  // and can't be introspected via the user-scoped endpoint. Fall through
  // to `/accounts` + `/accounts/:id/tokens/verify` to derive the id.
  const isAccountOwned = body?.errors?.some(
    (e) => e.code === ACCOUNT_OWNED_TOKEN_CODE
  );
  if (isAccountOwned) {
    return await deriveAccountIdViaAccountToken(token, fetcher, options);
  }

  throw new Error(
    `Cloudflare token verification failed with status ${response.status}. ` +
      `Check that CLOUDFLARE_API_TOKEN is valid or set ${options.overrideKey} ` +
      `/ CLOUDFLARE_ACCOUNT_ID explicitly.`
  );
}

/**
 * Account-owned token (cfat-) fallback: list the accounts the token can
 * see, and — if there's exactly one — confirm with the account-scoped
 * verify endpoint before returning the id.
 *
 * Common failure modes get specific, actionable error messages:
 *   - `/accounts` 403 (token lacks `account:read`): tell the caller to
 *     set `CLOUDFLARE_ACCOUNT_ID` explicitly.
 *   - multiple accounts: same.
 *   - zero accounts: same.
 *   - confirm step fails: surface the API error code verbatim.
 */
async function deriveAccountIdViaAccountToken(
  token: string,
  fetcher: typeof fetch,
  options: ResolveAccountIdOptions
): Promise<string> {
  // per_page=2 is the cheapest probe that still distinguishes one-vs-many.
  const listResponse = await fetchWithTimeout(
    fetcher,
    `${ACCOUNTS_LIST_URL}?per_page=2`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      }
    }
  );

  let listBody: AccountsListResponse;
  try {
    listBody = (await listResponse.json()) as AccountsListResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare account-owned token: /accounts returned malformed JSON: ${message}`
    );
  }

  if (!listResponse.ok || !listBody?.success) {
    throw new Error(
      'Cloudflare account-owned token (cfat-...) detected, but ' +
        `/accounts returned status ${listResponse.status}. The token may ` +
        'lack account:read scope. Set CLOUDFLARE_ACCOUNT_ID explicitly to ' +
        'skip introspection.'
    );
  }

  const accounts = listBody.result ?? [];
  if (accounts.length === 0) {
    throw new Error(
      'Cloudflare account-owned token has access to no accounts. ' +
        'Set CLOUDFLARE_ACCOUNT_ID explicitly.'
    );
  }
  if (accounts.length > 1) {
    throw new Error(
      'Cloudflare account-owned token has access to multiple accounts ' +
        '(ambiguous). Set CLOUDFLARE_ACCOUNT_ID explicitly to disambiguate.'
    );
  }
  const accountId = accounts[0]?.id;
  if (!accountId) {
    throw new Error(
      'Cloudflare /accounts returned a result without an id field.'
    );
  }

  // Confirm via the account-scoped verify endpoint. This is the canonical
  // check for account-owned tokens, and it doubles as proof that the token
  // is actually valid for the account we picked.
  const verifyResponse = await fetchWithTimeout(
    fetcher,
    `${ACCOUNTS_LIST_URL}/${encodeURIComponent(accountId)}/tokens/verify`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      }
    }
  );
  let verifyBody: AccountTokenVerifyResponse;
  try {
    verifyBody = (await verifyResponse.json()) as AccountTokenVerifyResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare account token verify returned malformed JSON: ${message}`
    );
  }
  if (!verifyResponse.ok || !verifyBody?.success) {
    const detail =
      verifyBody?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ??
      `HTTP ${verifyResponse.status}`;
    throw new Error(
      `Cloudflare account token verify failed for account ${accountId}: ${detail}`
    );
  }
  return accountId;
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
  const response = await fetchWithTimeout(fetcher, url, {
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
