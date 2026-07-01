/**
 * Account and zone inventory helpers for tunnel cleanup.
 *
 * This module owns paginated Cloudflare list endpoints and normalization
 * into small resource summaries. Destructive cleanup code consumes these
 * summaries instead of working with raw API response shapes.
 */

import { API_BASE, cfEnvelopeRequest, type Fetcher } from './request';

const PAGE_SIZE = 1000;

/**
 * Credentials bundle used by account- and zone-scoped tunnel helpers.
 * Tunnel-only helpers leave `zoneId` undefined; DNS helpers require it.
 */
export interface CloudflareCredentials {
  token: string;
  accountId: string;
  zoneId?: string;
  fetcher?: Fetcher;
}

export type TunnelStatus =
  | 'healthy'
  | 'down'
  | 'degraded'
  | 'inactive'
  | 'unknown';

/** Summary of a tunnel created by this SDK. */
export interface TunnelSummary {
  id: string;
  name: string;
  status: TunnelStatus;
  createdAt: Date | null;
  connsActiveAt: Date | null;
  connsInactiveAt: Date | null;
  deletedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

/** Summary of a DNS record marked with the SDK's `sandbox-` comment. */
export interface DNSSummary {
  id: string;
  name: string;
  type: string;
  content: string;
  comment: string | null;
  createdAt: Date | null;
}

export interface TunnelInventory {
  /** SDK-owned tunnels eligible for stale-tunnel evaluation. */
  sandboxTunnels: TunnelSummary[];
  /** Every non-deleted tunnel id in the account, independent of metadata. */
  liveTunnelIds: Set<string>;
}

interface ListTunnelsRaw {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ListDNSRaw {
  id: string;
  name: string;
  type: string;
  content: string;
  comment?: string | null;
  created_on?: string;
}

async function cfFullyPaginatedRequest<T>(
  urlBuilder: (page: number, perPage: number) => string,
  token: string,
  fetcher: Fetcher
): Promise<T[]> {
  const collected: T[] = [];
  let page = 1;
  for (;;) {
    const response = await cfEnvelopeRequest<T[]>(
      urlBuilder(page, PAGE_SIZE),
      token,
      fetcher
    );
    collected.push(...(response?.result ?? []));
    const totalPages = response?.result_info?.total_pages ?? 1;
    if (page >= totalPages) return collected;
    page += 1;
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSandboxTunnel(
  raw: ListTunnelsRaw,
  sandboxId: string | undefined
): boolean {
  const meta = raw.metadata ?? null;
  if (!meta || meta.createdBy !== 'sandbox-sdk') return false;
  return sandboxId === undefined || meta.sandboxId === sandboxId;
}

function toTunnelStatus(status: string | undefined): TunnelStatus {
  switch (status) {
    case 'healthy':
    case 'down':
    case 'degraded':
    case 'inactive':
      return status;
    default:
      return 'unknown';
  }
}

function toTunnelSummary(raw: ListTunnelsRaw): TunnelSummary {
  return {
    id: raw.id,
    name: raw.name,
    status: toTunnelStatus(raw.status),
    createdAt: parseDate(raw.created_at),
    connsActiveAt: parseDate(raw.conns_active_at),
    connsInactiveAt: parseDate(raw.conns_inactive_at),
    deletedAt: parseDate(raw.deleted_at),
    metadata: raw.metadata ?? null
  };
}

function toDNSSummary(raw: ListDNSRaw): DNSSummary {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    content: raw.content,
    comment: raw.comment ?? null,
    createdAt: parseDate(raw.created_on)
  };
}

async function listRawLiveTunnels(
  creds: CloudflareCredentials,
  fetcher: Fetcher
): Promise<ListTunnelsRaw[]> {
  const base = `${API_BASE}/accounts/${encodeURIComponent(creds.accountId)}/cfd_tunnel`;
  return await cfFullyPaginatedRequest<ListTunnelsRaw>(
    (page, perPage) =>
      `${base}?is_deleted=false&page=${page}&per_page=${perPage}`,
    creds.token,
    fetcher
  );
}

/**
 * List SDK-owned tunnels and all live tunnel IDs from the same account
 * inventory snapshot.
 */
export async function listTunnelInventory(
  creds: CloudflareCredentials,
  opts: { sandboxId?: string; fetcher?: Fetcher } = {}
): Promise<TunnelInventory> {
  const fetcher = opts.fetcher ?? creds.fetcher ?? fetch;
  const raw = await listRawLiveTunnels(creds, fetcher);
  return {
    sandboxTunnels: raw
      .filter((t) => isSandboxTunnel(t, opts.sandboxId))
      .map(toTunnelSummary),
    liveTunnelIds: new Set(raw.filter((t) => !t.deleted_at).map((t) => t.id))
  };
}

/** List SDK-owned Cloudflare tunnels in the account. */
export async function listSandboxTunnels(
  creds: CloudflareCredentials,
  opts: { sandboxId?: string; fetcher?: Fetcher } = {}
): Promise<TunnelSummary[]> {
  return (await listTunnelInventory(creds, opts)).sandboxTunnels;
}

/** List every non-deleted Cloudflare tunnel id in the account. */
export async function listLiveTunnelIds(
  creds: CloudflareCredentials,
  opts: { fetcher?: Fetcher } = {}
): Promise<Set<string>> {
  return (await listTunnelInventory(creds, opts)).liveTunnelIds;
}

/**
 * List CNAME records in the configured zone whose comments use the SDK
 * `sandbox-` marker. Cloudflare's server-side comment filter is paired
 * with a client-side exact lowercase prefix check.
 */
export async function listSandboxDNSRecords(
  creds: CloudflareCredentials,
  opts: { sandboxId?: string; fetcher?: Fetcher } = {}
): Promise<DNSSummary[]> {
  if (!creds.zoneId) {
    throw new Error(
      'listSandboxDNSRecords requires creds.zoneId. Pass it on CloudflareCredentials.'
    );
  }
  const fetcher = opts.fetcher ?? creds.fetcher ?? fetch;
  const base = `${API_BASE}/zones/${encodeURIComponent(creds.zoneId)}/dns_records`;
  const query = 'type=CNAME&comment.startswith=sandbox-';
  const raw = await cfFullyPaginatedRequest<ListDNSRaw>(
    (page, perPage) => `${base}?${query}&page=${page}&per_page=${perPage}`,
    creds.token,
    fetcher
  );
  return raw
    .filter((r) => {
      if (!r.comment?.startsWith('sandbox-')) return false;
      if (opts.sandboxId === undefined) return true;
      return r.comment === `sandbox-${opts.sandboxId}`;
    })
    .map(toDNSSummary);
}
