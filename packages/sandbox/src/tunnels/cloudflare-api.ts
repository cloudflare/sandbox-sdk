/**
 * Cloudflare API client for named-tunnel orchestration.
 *
 * Each export is a thin, focused wrapper over a single Cloudflare REST
 * endpoint. The wrappers exist to keep `tunnels-handler.ts` free of
 * URL strings and JSON munging, and to make every endpoint
 * individually mockable in unit tests via the injected `fetcher`.
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
 * - `upsertCname` is the most subtle wrapper: it lists existing
 *   records, reuses a matching one, and refuses to mutate a record
 *   whose content differs from what we want. This is the fence that
 *   stops two sandboxes from racing on the same hostname.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's standard envelope around every response. */
interface CloudflareEnvelope<T> {
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
}

/**
 * Internal request helper. Centralises auth header, JSON encoding, and
 * envelope unwrapping so each wrapper above stays declarative.
 */
async function cfRequest<T>(
  url: string,
  token: string,
  fetcher: Fetcher,
  options: RequestOptions = {}
): Promise<T | undefined> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetcher(url, init);
  if (options.acceptStatuses?.includes(response.status)) {
    return undefined;
  }

  let envelope: CloudflareEnvelope<T>;
  try {
    envelope = (await response.json()) as CloudflareEnvelope<T>;
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
  const result = await cfRequest<{ id: string; token: string }>(
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
        metadata: args.metadata
      }
    }
  );
  if (!result) {
    throw new Error('Cloudflare tunnel create returned no result body');
  }
  return { id: result.id, token: result.token };
}

export interface FindTunnelArgs extends BaseArgs {
  accountId: string;
  tunnelName: string;
}

export interface ExistingTunnel {
  id: string;
  name: string;
}

/**
 * Look up an existing tunnel by exact name match. Filters out tunnels
 * marked `deleted_at != null` defensively in case the API ignores the
 * `is_deleted=false` query parameter.
 */
export async function findTunnelByName(
  args: FindTunnelArgs
): Promise<ExistingTunnel | null> {
  const fetcher = args.fetcher ?? fetch;
  const url =
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel` +
    `?name=${encodeURIComponent(args.tunnelName)}&is_deleted=false`;
  const result = await cfRequest<
    Array<{ id: string; name: string; deleted_at?: string | null }>
  >(url, args.token, fetcher);
  if (!result) return null;
  const live = result.find((t) => !t.deleted_at);
  return live ? { id: live.id, name: live.name } : null;
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

export interface UpsertCnameArgs extends BaseArgs {
  zoneId: string;
  hostname: string;
  /** `<tunnel-id>.cfargotunnel.com`. */
  cnameTarget: string;
  /** `sandbox-<sandbox-id>` \u2014 used both for tagging and reuse matching. */
  comment: string;
}

export interface UpsertCnameResult {
  recordId: string;
  /** True when an existing matching record was reused; false when created. */
  reused: boolean;
}

interface DnsRecordEntry {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string | null;
  proxied?: boolean;
}

export async function upsertCname(
  args: UpsertCnameArgs
): Promise<UpsertCnameResult> {
  const fetcher = args.fetcher ?? fetch;
  const listUrl =
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records` +
    `?type=CNAME&name=${encodeURIComponent(args.hostname)}`;
  const records =
    (await cfRequest<DnsRecordEntry[]>(listUrl, args.token, fetcher)) ?? [];

  const existing = records.find(
    (r) => r.type === 'CNAME' && r.name === args.hostname
  );
  if (existing) {
    const sameContent = existing.content === args.cnameTarget;
    const sameComment = (existing.comment ?? '') === args.comment;
    if (sameContent && sameComment) {
      return { recordId: existing.id, reused: true };
    }
    throw new Error(
      `DNS record for ${args.hostname} already exists with different content ` +
        `(owned by you, not us): existing content="${existing.content}", ` +
        `existing comment="${existing.comment ?? ''}". Delete the record ` +
        'manually to allow the sandbox to manage it.'
    );
  }

  const createResult = await cfRequest<{ id: string }>(
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
        comment: args.comment
      }
    }
  );
  if (!createResult) {
    throw new Error('Cloudflare DNS create returned no result body');
  }
  return { recordId: createResult.id, reused: false };
}

export interface DeleteDnsRecordArgs extends BaseArgs {
  zoneId: string;
  recordId: string;
}

export async function deleteDnsRecord(
  args: DeleteDnsRecordArgs
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
