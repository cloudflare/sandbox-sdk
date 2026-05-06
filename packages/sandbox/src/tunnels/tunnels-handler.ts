/**
 * Tunnels namespace handler. Created once per Sandbox DO instance via
 * `createTunnelsHandler(sandbox)` and exposed as `sandbox.tunnels`.
 *
 * Responsibilities:
 *
 *   - Decide between quick and named mode based on options + env creds.
 *   - For named tunnels: orchestrate the Cloudflare API calls
 *     (create tunnel, upsert DNS, hand the token to the container).
 *   - Track DNS-record-id ↔ tunnel-id ↔ hostname so destroy() can
 *     clean up the right resources.
 *   - On failure, roll back partial provisioning so we don't leak CF
 *     resources.
 *
 * Credentials never leave the DO.
 */

import type {
  NamedTunnelInfo,
  QuickTunnelInfo,
  TunnelInfo
} from '@repo/shared';
import { getEnvString, type Logger, logCanonicalEvent } from '@repo/shared';
import type { SandboxClient } from '../clients';
import type { ContainerControlClient } from '../container-control';
import { SandboxSecurityError } from '../security';
import {
  type CloudflareCredentials,
  createTunnel,
  deleteDNSRecord,
  deleteTunnel,
  getZoneName,
  upsertDNSRecord
} from './cloudflare-api-client';

/**
 * Discriminated-union options. Using `mode` as the discriminator gives
 * us static guarantees that named-mode callers pass a hostname, and
 * quick-mode callers can't pass one by accident.
 */
export type CreateTunnelOptions =
  | { mode: 'quick' }
  | { mode: 'named'; hostname: string };

/** Subset of the Sandbox DO that the tunnels handler needs to read. */
export interface TunnelsHandlerHost {
  client: SandboxClient | ContainerControlClient;
  env: unknown;
  ctx: { id: { toString(): string } };
  sandboxName: string | null;
  logger: Logger;
}

export interface TunnelsHandler {
  create(port: number, options?: CreateTunnelOptions): Promise<TunnelInfo>;
  list(): Promise<TunnelInfo[]>;
  destroy(idOrInfo: string | TunnelInfo): Promise<void>;
}

const MIN_PORT = 1024;
const MAX_PORT = 9999;
const RESERVED_PORT = 3000; // sandbox control plane

function validateTunnelPort(port: number): void {
  if (
    !Number.isInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT ||
    port === RESERVED_PORT
  ) {
    throw new SandboxSecurityError(
      `Invalid port number: ${port}. Must be ${MIN_PORT}-${MAX_PORT}, excluding ${RESERVED_PORT} (sandbox control plane).`
    );
  }
}

/** 8-char hex id derived from `crypto.getRandomValues`. */
function shortId(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface TrackedRecord {
  mode: 'quick' | 'named';
  hostname?: string;
  dnsRecordId?: string;
}

export function createTunnelsHandler(host: TunnelsHandlerHost): TunnelsHandler {
  // Per-sandbox state. The handler is recreated when the DO is, so this
  // resets across DO eviction — see `.plans/02-tunnel-reconciler.md` for
  // the orphan-cleanup story.
  const records = new Map<string, TrackedRecord>();
  const zoneNameCache = new Map<string, string>();

  function tryReadCreds(): CloudflareCredentials | null {
    const env = host.env as Record<string, unknown>;
    const apiToken = getEnvString(env, 'CLOUDFLARE_API_TOKEN');
    const accountId = getEnvString(env, 'CLOUDFLARE_ACCOUNT_ID');
    const zoneId = getEnvString(env, 'CLOUDFLARE_ZONE_ID');
    if (!apiToken || !accountId || !zoneId) return null;
    return { apiToken, accountId, zoneId };
  }

  function readCreds(): CloudflareCredentials {
    const creds = tryReadCreds();
    if (creds) return creds;
    const env = host.env as Record<string, unknown>;
    const missing = [
      !getEnvString(env, 'CLOUDFLARE_API_TOKEN') && 'CLOUDFLARE_API_TOKEN',
      !getEnvString(env, 'CLOUDFLARE_ACCOUNT_ID') && 'CLOUDFLARE_ACCOUNT_ID',
      !getEnvString(env, 'CLOUDFLARE_ZONE_ID') && 'CLOUDFLARE_ZONE_ID'
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `Named tunnels require Cloudflare credentials in env: missing ${missing}`
    );
  }

  async function getZoneNameCached(
    creds: CloudflareCredentials
  ): Promise<string> {
    const cached = zoneNameCache.get(creds.zoneId);
    if (cached) return cached;
    const name = await getZoneName(creds);
    zoneNameCache.set(creds.zoneId, name);
    return name;
  }

  async function create(
    port: number,
    options?: CreateTunnelOptions
  ): Promise<TunnelInfo> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    const eventHostname =
      options?.mode === 'named' ? options.hostname : undefined;
    try {
      validateTunnelPort(port);

      // Decide between quick and named.
      //
      //   - mode === 'quick'                 → quick (explicit opt-out)
      //   - mode === 'named' (with hostname) → named with that hostname
      //   - no options + creds in env        → named with derived hostname
      //                                         `<sandbox-id>.<zone-name>`
      //   - no options + no creds            → quick (zero-config fallback)
      const explicitQuick = options?.mode === 'quick';
      const explicitNamed = options?.mode === 'named';
      const creds = explicitQuick ? null : tryReadCreds();
      let hostname: string | undefined = explicitNamed
        ? options.hostname
        : undefined;
      if (!explicitQuick && !hostname && creds) {
        const sandboxId = host.sandboxName ?? host.ctx.id.toString();
        const zoneName = await getZoneNameCached(creds);
        hostname = `${sandboxId}.${zoneName}`;
      }

      if (!hostname) {
        const id = `quick-${shortId()}`;
        const record = await host.client.tunnels.runQuickTunnel(id, port);
        if (!record.url || !record.hostname) {
          throw new Error('Container did not return a URL for quick tunnel');
        }
        const info: QuickTunnelInfo = {
          id: record.id,
          mode: 'quick',
          port: record.port,
          url: record.url,
          hostname: record.hostname,
          createdAt: record.createdAt
        };
        records.set(info.id, { mode: 'quick' });
        outcome = 'success';
        return info;
      }

      // Named mode. `creds` is non-null when we derived a hostname above;
      // for an explicit `mode: 'named'` we read them now.
      const namedCreds = creds ?? readCreds();
      const sandboxId = host.sandboxName ?? host.ctx.id.toString();

      const created = await createTunnel(namedCreds, { sandboxId });
      let dnsRecordId: string | undefined;
      try {
        const dns = await upsertDNSRecord(namedCreds, {
          hostname,
          cnameTarget: created.cnameTarget,
          sandboxId
        });
        dnsRecordId = dns.recordId;

        const record = await host.client.tunnels.runTokenTunnel(
          created.id,
          created.token,
          port
        );
        const info: NamedTunnelInfo = {
          id: record.id,
          mode: 'named',
          port: record.port,
          hostname,
          url: `https://${hostname}`,
          createdAt: record.createdAt
        };
        records.set(info.id, { mode: 'named', hostname, dnsRecordId });
        outcome = 'success';
        return info;
      } catch (err) {
        // Roll back partial provisioning so we don't leak CF resources.
        // Run both deletes concurrently and surface settlement results
        // so a failure on one doesn't skip the other.
        const cleanups: Array<Promise<unknown>> = [
          deleteTunnel(namedCreds, created.id)
        ];
        if (dnsRecordId) {
          cleanups.push(deleteDNSRecord(namedCreds, dnsRecordId));
        }
        const settled = await Promise.allSettled(cleanups);
        for (const r of settled) {
          if (r.status === 'rejected') {
            host.logger.warn('Rollback cleanup failed', {
              error: String(r.reason)
            });
          }
        }
        throw err;
      }
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.create',
        outcome,
        port,
        durationMs: Date.now() - startTime,
        hostname: eventHostname,
        error: caughtError
      });
    }
  }

  async function destroy(idOrInfo: string | TunnelInfo): Promise<void> {
    const id = typeof idOrInfo === 'string' ? idOrInfo : idOrInfo.id;
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    try {
      const record = records.get(id);

      // Always tell the container to stop cloudflared first — if it's
      // already gone we surface a TUNNEL_NOT_FOUND we can ignore. We
      // do this synchronously (not concurrent with the CF API deletes)
      // so we never delete the DNS / tunnel resources while cloudflared
      // is still serving traffic through them.
      try {
        await host.client.tunnels.destroyTunnel(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('TUNNEL_NOT_FOUND')) throw err;
      }

      if (record?.mode === 'named') {
        const creds = readCreds();
        const cleanups: Array<Promise<unknown>> = [deleteTunnel(creds, id)];
        if (record.dnsRecordId) {
          cleanups.push(deleteDNSRecord(creds, record.dnsRecordId));
        }
        const settled = await Promise.allSettled(cleanups);
        for (const r of settled) {
          if (r.status === 'rejected') {
            host.logger.warn('Failed to delete CF resource on destroy', {
              tunnelId: id,
              error: String(r.reason)
            });
          }
        }
      }
      records.delete(id);
      outcome = 'success';
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(host.logger, {
        event: 'tunnel.destroy',
        outcome,
        tunnelId: id,
        durationMs: Date.now() - startTime,
        error: caughtError
      });
    }
  }

  /**
   * List tunnels currently running inside the container.
   *
   * For named tunnels we enrich the container's record with the
   * hostname we tracked when calling `create()` — the container itself
   * does not know which hostname a token tunnel is bound to.
   */
  async function list(): Promise<TunnelInfo[]> {
    const containerRecords = await host.client.tunnels.listTunnels();
    return containerRecords.map((r): TunnelInfo => {
      if (r.mode === 'quick') {
        return {
          id: r.id,
          mode: 'quick',
          port: r.port,
          url: r.url ?? '',
          hostname: r.hostname ?? '',
          createdAt: r.createdAt
        };
      }
      const tracked = records.get(r.id);
      const hostname =
        tracked?.mode === 'named' ? (tracked.hostname ?? '') : '';
      return {
        id: r.id,
        mode: 'named',
        port: r.port,
        hostname,
        url: hostname ? `https://${hostname}` : '',
        createdAt: r.createdAt
      };
    });
  }

  return { create, list, destroy };
}
