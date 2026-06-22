import type { Logger } from '@repo/shared';
import { deleteDNSRecord, deleteTunnel } from './cloudflare-api';
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
  let cleanupFailed = false;
  await Promise.allSettled([
    entry.dnsRecordId
      ? deleteDNSRecord({
          token: config.token,
          zoneId,
          recordId: entry.dnsRecordId,
          fetcher
        }).catch((err) => {
          cleanupFailed = true;
          host.logger.warn(`${logPrefix}: dns delete failed`, {
            port: entry.port,
            tunnelId: entry.tunnelId,
            recordId: entry.dnsRecordId,
            zoneId,
            error: err instanceof Error ? err.message : String(err)
          });
        })
      : Promise.resolve(),
    deleteTunnel({
      token: config.token,
      accountId,
      tunnelId: entry.tunnelId,
      fetcher
    }).catch((err) => {
      cleanupFailed = true;
      host.logger.warn(`${logPrefix}: tunnel delete failed`, {
        port: entry.port,
        tunnelId: entry.tunnelId,
        accountId,
        error: err instanceof Error ? err.message : String(err)
      });
    })
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
  }
): Promise<boolean> {
  if (!(await cleanupNamedTunnelResources(host, entry, options))) {
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
