/**
 * Cloudflare REST helpers for the named-tunnel flow.
 *
 * Resources are tagged so they can be reconciled out-of-band:
 *   - Tunnel:    `metadata: { sandboxId, createdBy, ... }`
 *   - DNS record: `comment: 'sandbox-<id>'` (universal)
 *                 `tags: ['sandbox-sdk', 'sandbox-<id>']` (best-effort, EE-only)
 */

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareCredentials {
  apiToken: string;
  accountId: string;
  zoneId: string;
}

export interface CreatedTunnel {
  /** Tunnel UUID. */
  id: string;
  /** Token cloudflared consumes via `--token`. */
  token: string;
  /** The `<tunnel-id>.cfargotunnel.com` host clients CNAME to. */
  cnameTarget: string;
}

export interface UpsertedDNSRecord {
  recordId: string;
  hostname: string;
}

interface ResponseEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

/**
 * Build a fetch-like client bound to a token. The returned function takes
 * a path (e.g. `/zones/:id`) and the standard `RequestInit`, prefixes the
 * path with the Cloudflare API base, attaches the bearer token and JSON
 * content-type, and unwraps the `result` field on success or throws on
 * failure.
 */
function cf({ token }: { token: string }) {
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const url = `${CLOUDFLARE_API_BASE}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    });
    const body = (await res.json().catch(() => ({}))) as ResponseEnvelope<T>;
    if (!res.ok || !body.success) {
      const detail =
        body.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ??
        `HTTP ${res.status}`;
      throw new Error(`Cloudflare API error (${url}): ${detail}`);
    }
    return body.result as T;
  };
}

/**
 * Look up the zone's DNS name (e.g. `example.com`) by zone id.
 *
 * Used by `Sandbox.tunnels.create()` to derive a default hostname when
 * the caller doesn't supply one. Cached caller-side for the lifetime of
 * the DO so we only hit this once per zone per isolate.
 */
export async function getZoneName(
  creds: CloudflareCredentials
): Promise<string> {
  const api = cf({ token: creds.apiToken });
  const result = await api<{ name: string }>(`/zones/${creds.zoneId}`);
  return result.name;
}

/**
 * Create a tunnel with `config_src: 'cloudflare'` so cloudflared can run
 * with `--token` (no local config file needed). Tags with `metadata.sandboxId`.
 */
export async function createTunnel(
  creds: CloudflareCredentials,
  opts: { sandboxId: string; tunnelLabel?: string }
): Promise<CreatedTunnel> {
  const api = cf({ token: creds.apiToken });
  const name = opts.tunnelLabel ?? `sandbox-${opts.sandboxId}-${shortId()}`;
  type CreateResult = { id: string; token: string };
  const result = await api<CreateResult>(
    `/accounts/${creds.accountId}/cfd_tunnel`,
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        config_src: 'cloudflare',
        metadata: {
          sandboxId: opts.sandboxId,
          createdBy: 'sandbox-sdk',
          tunnelLabel: name
        }
      })
    }
  );
  return {
    id: result.id,
    token: result.token,
    cnameTarget: `${result.id}.cfargotunnel.com`
  };
}

/**
 * Create or update a CNAME pointing at the tunnel. Idempotent: if a record
 * with the same name and content already exists we reuse it; if a record
 * exists pointing at something else we fail loudly (the user owns that
 * name).
 */
export async function upsertDNSRecord(
  creds: CloudflareCredentials,
  opts: { hostname: string; cnameTarget: string; sandboxId: string }
): Promise<UpsertedDNSRecord> {
  const api = cf({ token: creds.apiToken });
  type DNSRecord = {
    id: string;
    name: string;
    content: string;
    type: string;
  };

  // Look for an existing record with this name first.
  const existing = await api<DNSRecord[]>(
    `/zones/${creds.zoneId}/dns_records?name=${encodeURIComponent(opts.hostname)}`
  );

  if (existing.length > 0) {
    const rec = existing[0];
    if (rec.type === 'CNAME' && rec.content === opts.cnameTarget) {
      return { recordId: rec.id, hostname: opts.hostname };
    }
    throw new Error(
      `DNS record for ${opts.hostname} already exists with different content (${rec.type} ${rec.content})`
    );
  }

  const comment = `sandbox-${opts.sandboxId}`;
  const baseBody = {
    type: 'CNAME' as const,
    name: opts.hostname,
    content: opts.cnameTarget,
    proxied: true,
    comment
  };

  // Try with `tags` first (Enterprise), retry without on 4xx.
  try {
    const result = await api<DNSRecord>(`/zones/${creds.zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        ...baseBody,
        tags: ['sandbox-sdk', `sandbox-${opts.sandboxId}`]
      })
    });
    return { recordId: result.id, hostname: opts.hostname };
  } catch (_err) {
    const result = await api<DNSRecord>(`/zones/${creds.zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(baseBody)
    });
    return { recordId: result.id, hostname: opts.hostname };
  }
}

export async function deleteDNSRecord(
  creds: CloudflareCredentials,
  recordId: string
): Promise<void> {
  const api = cf({ token: creds.apiToken });
  await api<{ id: string }>(`/zones/${creds.zoneId}/dns_records/${recordId}`, {
    method: 'DELETE'
  });
}

export async function deleteTunnel(
  creds: CloudflareCredentials,
  tunnelId: string
): Promise<void> {
  const api = cf({ token: creds.apiToken });
  await api<{ id: string }>(
    `/accounts/${creds.accountId}/cfd_tunnel/${tunnelId}`,
    { method: 'DELETE' }
  );
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
