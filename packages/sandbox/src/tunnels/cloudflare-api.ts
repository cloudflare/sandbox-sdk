/**
 * Cloudflare API client for named-tunnel orchestration.
 *
 * Design notes:
 *
 * - The Cloudflare API envelope is `{ success, result, errors }`. We
 *   unwrap `result` on success and surface a thrown `Error` with the
 *   API error code/message on failure. Transport-level errors
 *   propagate unchanged.
 * - Delete endpoints are idempotent from the caller's perspective:
 *   a 404 (already gone) resolves successfully so destroy() can run
 *   without special-casing.
 * - `upsertCNAME` is the most subtle wrapper: it lists existing
 *   records, reuses a matching one, and refuses to mutate a record
 *   whose content differs from what we want. This is the fence that
 *   stops two sandboxes from racing on the same hostname.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's standard envelope around every response. */
interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

type Fetcher = typeof fetch;

interface BaseArgs {
  token: string;
  fetcher?: Fetcher;
}

/**
 * Tag attached to every tunnel resource the SDK creates. Survives
 * round-tripping through the Cloudflare API so `findTunnelByName` can
 * reconcile orphaned resources from a previous failed attempt.
 */
export interface TunnelMetadata {
  sandboxId: string;
  createdBy: 'sandbox-sdk';
  name: string;
  port: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Treat these HTTP statuses as success and skip envelope parsing. */
  acceptStatuses?: number[];
  /**
   * Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS`.
   * Without a timeout a hung Cloudflare call wedges the per-port lock in
   * `tunnels-handler.ts` indefinitely, which then blocks every subsequent
   * `get(port)` / `destroy(port)` on that port. The shared
   * `#zoneNamePromise` makes the impact span every port for named
   * tunnels.
   */
  timeoutMs?: number;
}

/**
 * Default request timeout. Cloudflare API P99 latency is well under
 * this; values much smaller risk false positives on cold control-plane
 * paths (e.g. first `cfd_tunnel` POST in a new account).
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Internal request helper. Centralises auth header, JSON encoding,
 * timeout enforcement, and envelope unwrapping so each wrapper above
 * stays declarative.
 */
async function cfRequest<T>(
  url: string,
  token: string,
  fetcher: Fetcher,
  options: RequestOptions = {}
): Promise<T | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (err) {
    // `AbortSignal.timeout` rejects with a DOMException whose name is
    // 'TimeoutError'. Surface it as a clearly-labelled error so callers
    // can distinguish a transport hang from a Cloudflare-side failure;
    // a SandboxSecurityError-shaped class would be better but we keep
    // the error shape consistent with the rest of this module.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Cloudflare API request to ${url} timed out after ${timeoutMs}ms`
      );
    }
    throw err;
  }
  if (options.acceptStatuses?.includes(response.status)) {
    return undefined;
  }

  let envelope: CloudflareResponse<T>;
  try {
    envelope = (await response.json()) as CloudflareResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare API returned non-JSON response (status ${response.status}): ${message}`
    );
  }

  if (!response.ok || envelope.success === false) {
    const errs = envelope.errors ?? [];
    const summary = errs.length
      ? errs
          .map((e) => `${e.code ?? '???'}: ${e.message ?? 'unknown'}`)
          .join(', ')
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API error: ${summary}`);
  }

  return envelope.result;
}

/**
 * Heuristic for the "tags are an Enterprise-only feature" error class.
 * Cloudflare's documented codes shift over time and the API also bounces
 * with HTTP 403 + a free-text message; match by message substring to
 * stay robust across both shapes. Used by the create-tunnel and
 * create-DNS paths to fall back to an untagged request automatically.
 */
function isEnterpriseOnlyTagError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (!msg.includes('tag')) return false;
  return (
    msg.includes('enterprise') ||
    msg.includes('not allowed') ||
    msg.includes('not entitled') ||
    msg.includes('not available') ||
    msg.includes('not supported')
  );
}

/**
 * Build the `tags` field attached to created Cloudflare resources. The
 * tag is `sandboxId:<id>`, the same key used in DNS comments / tunnel
 * metadata; together they let an operator find every resource a given
 * sandbox owns from the Cloudflare dashboard.
 *
 * Tags are an Enterprise-only feature. The wrapper `createWithTagFallback`
 * automatically retries the request without tags on the documented
 * "requires Enterprise" error so non-enterprise accounts succeed without
 * any configuration.
 */
function buildSandboxTags(sandboxId: string | undefined): string[] | undefined {
  if (!sandboxId) return undefined;
  return [`sandboxId:${sandboxId}`];
}

/**
 * Wrap a tagged-create request with an automatic tag-strip retry. The
 * callback receives `tags`: pass it through to the request body as-is on
 * the first call (`undefined` on the retry). The retry only fires for
 * the Enterprise-only tag error class; any other failure surfaces
 * verbatim.
 */
async function createWithTagFallback<T>(
  sandboxId: string | undefined,
  send: (tags: string[] | undefined) => Promise<T>
): Promise<T> {
  const tags = buildSandboxTags(sandboxId);
  if (!tags) return send(undefined);
  try {
    return await send(tags);
  } catch (err) {
    if (!isEnterpriseOnlyTagError(err)) throw err;
    return send(undefined);
  }
}

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------

export interface CreateTunnelArgs extends BaseArgs {
  accountId: string;
  /**
   * The on-Cloudflare display name for the tunnel resource. Conventionally
   * `sandbox-<sandboxId>-<userName>` so it's stable per (sandbox, name).
   */
  tunnelName: string;
  metadata: TunnelMetadata;
}

export interface CreatedTunnel {
  id: string;
  /** Opaque `--token` for `cloudflared tunnel run --token <T>`. */
  token: string;
}

export async function createTunnel(
  args: CreateTunnelArgs
): Promise<CreatedTunnel> {
  const fetcher = args.fetcher ?? fetch;
  // Tags are an Enterprise feature; `createWithTagFallback` retries
  // without the `tags` field on a documented Enterprise-only error so
  // non-enterprise accounts still succeed.
  const result = await createWithTagFallback(args.metadata.sandboxId, (tags) =>
    cfRequest<{ id: string; token: string }>(
      `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel`,
      args.token,
      fetcher,
      {
        method: 'POST',
        body: {
          name: args.tunnelName,
          // `cloudflare` lets cloudflared run with just --token, no local
          // config file. The alternative `local` requires a YAML config.
          config_src: 'cloudflare',
          metadata: args.metadata,
          ...(tags ? { tags } : {})
        }
      }
    )
  );
  if (!result) {
    throw new Error('Cloudflare tunnel create returned no result body');
  }
  return { id: result.id, token: result.token };
}

export interface FindTunnelArgs extends BaseArgs {
  accountId: string;
  tunnelName: string;
  /**
   * When set, only return tunnels whose `metadata.sandboxId` equals this
   * value. Otherwise the function matches by name alone.
   *
   * Use this to defend against the case where two sandboxes happen to
   * mint the same tunnel name (the name conventionally encodes the
   * sandbox id, but the API does not enforce that): without the
   * metadata check, sandbox B's `findTunnelByName` would happily claim
   * sandbox A's tunnel and start managing it.
   */
  expectedSandboxId?: string;
}

export interface ExistingTunnel {
  id: string;
  name: string;
}

/**
 * Look up an existing tunnel by exact name match. Filters out tunnels
 * marked `deleted_at != null` defensively in case the API ignores the
 * `is_deleted=false` query parameter.
 *
 * When `expectedSandboxId` is provided, also verify that the tunnel's
 * `metadata.sandboxId` tag matches — this is the authoritative "this
 * resource was created by this sandbox" check, and the tag is set by
 * `createTunnel`. Mismatches are treated as "not found" so the caller
 * falls through to creating a fresh tunnel.
 */
export async function findTunnelByName(
  args: FindTunnelArgs
): Promise<ExistingTunnel | null> {
  const fetcher = args.fetcher ?? fetch;
  const url =
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel` +
    `?name=${encodeURIComponent(args.tunnelName)}&is_deleted=false`;
  const result = await cfRequest<
    Array<{
      id: string;
      name: string;
      deleted_at?: string | null;
      metadata?: unknown;
    }>
  >(url, args.token, fetcher);
  if (!result) return null;
  const live = result.find((t) => !t.deleted_at);
  if (!live) return null;
  if (args.expectedSandboxId !== undefined) {
    const meta = live.metadata as { sandboxId?: unknown } | undefined;
    if (meta?.sandboxId !== args.expectedSandboxId) return null;
  }
  return { id: live.id, name: live.name };
}

export interface DeleteTunnelArgs extends BaseArgs {
  accountId: string;
  tunnelId: string;
}

export async function deleteTunnel(args: DeleteTunnelArgs): Promise<void> {
  const fetcher = args.fetcher ?? fetch;
  await cfRequest<unknown>(
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel/${encodeURIComponent(args.tunnelId)}`,
    args.token,
    fetcher,
    {
      method: 'DELETE',
      // 404 is a successful (already-gone) outcome so destroy() can
      // chain other cleanup steps without surfacing benign races.
      acceptStatuses: [404]
    }
  );
}

export interface GetTunnelTokenArgs extends BaseArgs {
  accountId: string;
  tunnelId: string;
}

/**
 * Fetch the opaque `--token` for an existing tunnel. Used on the retry
 * path: when `findTunnelByName` discovers a tunnel left behind from a
 * previous failed attempt, we need its token to run `cloudflared` again.
 *
 * The Cloudflare API returns the token as a bare quoted string in the
 * `result` envelope (e.g. `"<base64-token>"`).
 */
export async function getTunnelToken(
  args: GetTunnelTokenArgs
): Promise<string> {
  const fetcher = args.fetcher ?? fetch;
  const result = await cfRequest<string>(
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel/${encodeURIComponent(args.tunnelId)}/token`,
    args.token,
    fetcher
  );
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error(
      `Cloudflare did not return a token for tunnel ${args.tunnelId}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export interface GetZoneNameArgs extends BaseArgs {
  zoneId: string;
}

export async function getZoneName(args: GetZoneNameArgs): Promise<string> {
  const fetcher = args.fetcher ?? fetch;
  const result = await cfRequest<{ id: string; name: string }>(
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}`,
    args.token,
    fetcher
  );
  if (!result?.name) {
    throw new Error(`Cloudflare zone ${args.zoneId} did not return a name`);
  }
  return result.name;
}

// ---------------------------------------------------------------------------
// DNS records
// ---------------------------------------------------------------------------

export interface UpsertCNAMEArgs extends BaseArgs {
  zoneId: string;
  hostname: string;
  /** `<tunnel-id>.cfargotunnel.com`. */
  cnameTarget: string;
  /** `sandbox-<sandbox-id>` — used both for tagging and reuse matching. */
  comment: string;
  /**
   * Sandbox id used to build the `sandboxId:<id>` Cloudflare tag
   * attached to the created DNS record. Tags are an Enterprise-only
   * feature; the create call falls back to an untagged record on the
   * documented "requires Enterprise" error. Omit to skip tagging.
   */
  sandboxId?: string;
}

export interface UpsertCNAMEResult {
  recordId: string;
  /** True when an existing matching record was reused; false when created. */
  reused: boolean;
}

interface DNSRecordEntry {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string | null;
  proxied?: boolean;
}

export async function upsertCNAME(
  args: UpsertCNAMEArgs
): Promise<UpsertCNAMEResult> {
  const fetcher = args.fetcher ?? fetch;
  const listUrl =
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records` +
    `?type=CNAME&name=${encodeURIComponent(args.hostname)}`;
  const records =
    (await cfRequest<DNSRecordEntry[]>(listUrl, args.token, fetcher)) ?? [];

  const existing = records.find(
    (r) => r.type === 'CNAME' && r.name === args.hostname
  );
  if (existing) {
    // The CNAME content `<tunnel-id>.cfargotunnel.com` is the
    // authoritative "ours" check: only the holder of the tunnel id
    // could have asked Cloudflare to mint that target. Comment is
    // free text that operators commonly edit through the dashboard,
    // so we deliberately do not key reuse on it.
    if (existing.content === args.cnameTarget) {
      return { recordId: existing.id, reused: true };
    }
    throw new Error(
      `DNS record for ${args.hostname} already exists with different content ` +
        `(owned by you, not us): existing content="${existing.content}", ` +
        `existing comment="${existing.comment ?? ''}". Delete the record ` +
        'manually to allow the sandbox to manage it.'
    );
  }

  const createResult = await createWithTagFallback(args.sandboxId, (tags) =>
    cfRequest<{ id: string }>(
      `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records`,
      args.token,
      fetcher,
      {
        method: 'POST',
        body: {
          type: 'CNAME',
          name: args.hostname,
          content: args.cnameTarget,
          proxied: true,
          comment: args.comment,
          ...(tags ? { tags } : {})
        }
      }
    )
  );
  if (!createResult) {
    throw new Error('Cloudflare DNS create returned no result body');
  }
  return { recordId: createResult.id, reused: false };
}

export interface DeleteDNSRecordArgs extends BaseArgs {
  zoneId: string;
  recordId: string;
}

export async function deleteDNSRecord(
  args: DeleteDNSRecordArgs
): Promise<void> {
  const fetcher = args.fetcher ?? fetch;
  await cfRequest<unknown>(
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records/${encodeURIComponent(args.recordId)}`,
    args.token,
    fetcher,
    {
      method: 'DELETE',
      acceptStatuses: [404]
    }
  );
}
