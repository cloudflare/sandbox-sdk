import type { Logger } from '@repo/shared';
import {
  deleteDNSRecord,
  deleteTunnel,
  findCNAME,
  findTunnelByName
} from './cloudflare-api';
import {
  CLEANUP_STORAGE_KEY,
  readCleanupMap,
  type TunnelCleanupEntry,
  type TunnelsStorage
} from './storage';

export interface NamedTunnelCleanupHost {
  logger: Logger;
  getNamedTunnelConfig?: () => Promise<{
    token: string;
    accountId: string;
    zoneId: string;
  }>;
  fetcher?: typeof fetch;
}

export async function cleanupNamedTunnelResources(
  host: NamedTunnelCleanupHost,
  entry: TunnelCleanupEntry,
  options?: {
    logPrefix?: string;
    credentialsUnavailableMessage?: string;
    onResolved?: (entry: TunnelCleanupEntry) => Promise<void>;
  }
): Promise<boolean> {
  const logPrefix = options?.logPrefix ?? 'tunnel.cleanup';
  if (!host.getNamedTunnelConfig) {
    host.logger.warn(
      options?.credentialsUnavailableMessage ??
        `${logPrefix}: credentials unavailable`,
      {
        port: entry.port,
        tunnelId: entry.tunnelId,
        dnsRecordId: entry.dnsRecordId,
        error: 'Named tunnel configuration resolver is unavailable'
      }
    );
    return false;
  }

  let config: { token: string; accountId: string; zoneId: string };
  try {
    config = await host.getNamedTunnelConfig();
  } catch (err) {
    host.logger.warn(
      options?.credentialsUnavailableMessage ??
        `${logPrefix}: credentials unavailable`,
      {
        port: entry.port,
        tunnelId: entry.tunnelId,
        dnsRecordId: entry.dnsRecordId,
        error: err instanceof Error ? err.message : String(err)
      }
    );
    return false;
  }

  const accountId = entry.accountId ?? config.accountId;
  const zoneId = entry.zoneId ?? config.zoneId;
  const fetcher = host.fetcher;
  let tunnelId = entry.tunnelId;
  if (!tunnelId && entry.tunnelName && entry.sandboxId) {
    const tunnel = await findTunnelByName({
      token: config.token,
      accountId,
      tunnelName: entry.tunnelName,
      expectedSandboxId: entry.sandboxId,
      fetcher
    });
    tunnelId = tunnel?.id;
  }

  let dnsRecordId = entry.dnsRecordId;
  if (!dnsRecordId && tunnelId) {
    const dnsRecord = await findCNAME({
      token: config.token,
      zoneId,
      hostname: entry.hostname,
      cnameTarget: `${tunnelId}.cfargotunnel.com`,
      fetcher
    });
    dnsRecordId = dnsRecord?.recordId;
  }

  if (tunnelId || dnsRecordId) {
    await options?.onResolved?.({
      ...entry,
      ...(tunnelId && { tunnelId }),
      ...(dnsRecordId && { dnsRecordId }),
      phase: dnsRecordId ? 'claimed' : 'tunnel_ready',
      updatedAt: new Date().toISOString()
    });
  }

  if (!tunnelId && !dnsRecordId) return true;

  let cleanupFailed = false;
  await Promise.allSettled([
    dnsRecordId
      ? deleteDNSRecord({
          token: config.token,
          zoneId,
          recordId: dnsRecordId,
          fetcher
        }).catch((err) => {
          cleanupFailed = true;
          host.logger.warn(`${logPrefix}: dns delete failed`, {
            port: entry.port,
            tunnelId,
            recordId: dnsRecordId,
            zoneId,
            error: err instanceof Error ? err.message : String(err)
          });
        })
      : Promise.resolve(),
    tunnelId
      ? deleteTunnel({
          token: config.token,
          accountId,
          tunnelId,
          fetcher
        }).catch((err) => {
          cleanupFailed = true;
          host.logger.warn(`${logPrefix}: tunnel delete failed`, {
            port: entry.port,
            tunnelId,
            accountId,
            error: err instanceof Error ? err.message : String(err)
          });
        })
      : Promise.resolve()
  ]);

  return !cleanupFailed;
}

export async function resumeNamedTunnelCleanupEntry(
  host: NamedTunnelCleanupHost,
  storage: TunnelsStorage,
  portKey: string,
  entry: TunnelCleanupEntry,
  options?: {
    logPrefix?: string;
    credentialsUnavailableMessage?: string;
    onResolved?: (entry: TunnelCleanupEntry) => Promise<void>;
  }
): Promise<boolean> {
  if (
    !(await cleanupNamedTunnelResources(host, entry, {
      ...options,
      onResolved: async (resolved) => {
        await storage.transaction(async (txn) => {
          const cleanup = await readCleanupMap(txn);
          cleanup[portKey] = resolved;
          await txn.put(CLEANUP_STORAGE_KEY, cleanup);
        });
        await options?.onResolved?.(resolved);
      }
    }))
  ) {
    return false;
  }

  await storage.transaction(async (txn) => {
    const cleanup = await readCleanupMap(txn);
    delete cleanup[portKey];
    await txn.put(CLEANUP_STORAGE_KEY, cleanup);
  });
  return true;
}

export async function resumeNamedTunnelCleanupRecords(
  host: NamedTunnelCleanupHost,
  storage: TunnelsStorage
): Promise<void> {
  const cleanup = await readCleanupMap(storage);
  for (const [portKey, entry] of Object.entries(cleanup)) {
    try {
      await resumeNamedTunnelCleanupEntry(host, storage, portKey, entry);
    } catch (err) {
      host.logger.warn('tunnels.resumeCleanup: cleanup record failed', {
        port: entry.port,
        tunnelId: entry.tunnelId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
