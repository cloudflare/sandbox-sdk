import type { NamedTunnelInfo, TunnelInfo, TunnelOptions } from '@repo/shared';
import type { RuntimeIdentityID } from '../current-runtime-identity';
import type { SandboxLifetimeID } from '../sandbox-lifetime';

/** DO storage key for the `port → TunnelInfo` map. */
export const STORAGE_KEY = 'tunnels';

/**
 * Sidecar storage key for per-port metadata the handler needs but the
 * public `TunnelInfo` shape does not carry.
 */
export const META_STORAGE_KEY = 'tunnels:meta';

export const CLEANUP_STORAGE_KEY = 'tunnels:cleanup';

export type TunnelMap = Record<string, TunnelInfo>;

export interface TunnelMetaEntry {
  /** Stable hash of the `options` object the tunnel was created with. */
  optionsHash: string;
  /** Cloudflare DNS record id for named tunnels; absent for quick. */
  dnsRecordId?: string;
  /** Runtime identity that owns the current cloudflared process. */
  runtimeIdentityID?: RuntimeIdentityID;
  /** Sandbox lifetime that owns this tunnel record. */
  sandboxLifetimeID?: SandboxLifetimeID;
  /** Runtime-local cloudflared run that owns current process callbacks. */
  tunnelRunId?: string;
  /** Cloudflare tunnel id for hidden named records that can respawn or clean up. */
  tunnelId?: string;
  /** User-provided named-tunnel label for hidden respawn/cleanup records. */
  name?: string;
  /** Public named-tunnel hostname for hidden respawn/cleanup records. */
  hostname?: string;
  /**
   * Resolved `(accountId, zoneId)` the named tunnel was provisioned
   * against. Compared on cache hit to detect env-var changes that
   * would otherwise silently serve a stale URL.
   */
  accountId?: string;
  zoneId?: string;
  /**
   * Set for hidden named tunnels whose Cloudflare resources outlived
   * the runtime-local cloudflared process.
   */
  needsRespawn?: boolean;
}

export type TunnelMetaMap = Record<string, TunnelMetaEntry>;

export type TunnelCleanupPhase = 'planned' | 'tunnel_ready' | 'claimed';

export interface TunnelCleanupEntry {
  tunnelId?: string;
  port: number;
  name: string;
  hostname: string;
  tunnelName?: string;
  sandboxId?: string;
  dnsRecordId?: string;
  accountId?: string;
  zoneId?: string;
  phase: TunnelCleanupPhase;
  updatedAt: string;
}

export type TunnelCleanupMap = Record<string, TunnelCleanupEntry>;

/**
 * Subset of `DurableObjectTransaction` (and `DurableObjectStorage`) used
 * inside a transaction closure — no nested `transaction()`.
 */
export interface TunnelsStorageTxn {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/**
 * Subset of `DurableObjectStorage` the handler uses.
 *
 * `transaction` gives optimistic concurrency for read-modify-write paths.
 */
export interface TunnelsStorage extends TunnelsStorageTxn {
  transaction<T>(closure: (txn: TunnelsStorageTxn) => Promise<T>): Promise<T>;
}

export async function readMap(storage: TunnelsStorageTxn): Promise<TunnelMap> {
  return (await storage.get<TunnelMap>(STORAGE_KEY)) ?? {};
}

export async function readMetaMap(
  storage: TunnelsStorageTxn
): Promise<TunnelMetaMap> {
  return (await storage.get<TunnelMetaMap>(META_STORAGE_KEY)) ?? {};
}

export async function readCleanupMap(
  storage: TunnelsStorageTxn
): Promise<TunnelCleanupMap> {
  return (await storage.get<TunnelCleanupMap>(CLEANUP_STORAGE_KEY)) ?? {};
}

export interface TunnelPortState {
  info?: TunnelInfo;
  meta?: TunnelMetaEntry;
  cleanup?: TunnelCleanupEntry;
}

export async function readPortState(
  storage: TunnelsStorageTxn,
  port: number
): Promise<TunnelPortState> {
  const portKey = port.toString();
  const [map, meta, cleanup] = await Promise.all([
    readMap(storage),
    readMetaMap(storage),
    readCleanupMap(storage)
  ]);
  return {
    info: map[portKey],
    meta: meta[portKey],
    cleanup: cleanup[portKey]
  };
}

function setOptionalMapValue<T>(
  map: Record<string, T>,
  key: string,
  value: T | undefined
): void {
  if (value === undefined) {
    delete map[key];
    return;
  }
  map[key] = value;
}

export interface TunnelPortStatePatch {
  info?: TunnelInfo;
  meta?: TunnelMetaEntry;
  cleanup?: TunnelCleanupEntry;
}

export async function updatePortState(
  storage: TunnelsStorage,
  port: number,
  updater: (
    state: Readonly<TunnelPortState>
  ) =>
    | TunnelPortStatePatch
    | undefined
    | Promise<TunnelPortStatePatch | undefined>
): Promise<void> {
  await storage.transaction(async (txn) => {
    const portKey = port.toString();
    const [map, meta, cleanup] = await Promise.all([
      readMap(txn),
      readMetaMap(txn),
      readCleanupMap(txn)
    ]);
    const state: TunnelPortState = {
      info: map[portKey],
      meta: meta[portKey],
      cleanup: cleanup[portKey]
    };
    const patch = await updater(state);

    const writes: Array<Promise<void>> = [];
    if (patch && 'info' in patch && patch.info !== state.info) {
      setOptionalMapValue(map, portKey, patch.info);
      writes.push(txn.put(STORAGE_KEY, map));
    }
    if (patch && 'meta' in patch && patch.meta !== state.meta) {
      setOptionalMapValue(meta, portKey, patch.meta);
      writes.push(txn.put(META_STORAGE_KEY, meta));
    }
    if (patch && 'cleanup' in patch && patch.cleanup !== state.cleanup) {
      setOptionalMapValue(cleanup, portKey, patch.cleanup);
      writes.push(txn.put(CLEANUP_STORAGE_KEY, cleanup));
    }
    await Promise.all(writes);
  });
}

/**
 * Stable hash of `options`. Empty/undefined options collapse to the same
 * hash so `get(port)`, `get(port, {})`, and `get(port, { name: undefined })`
 * all hit the same cache entry. Named tunnels hash on `name` alone.
 */
export function computeOptionsHash(options?: TunnelOptions): string {
  if (!options || !options.name) return 'v1:quick';
  return `v1:named:${options.name}`;
}

/** Strip the optional `v1:` prefix so legacy hashes compare equal. */
function normaliseHash(hash: string): string {
  return hash.startsWith('v1:') ? hash.slice(3) : hash;
}

export function optionsHashesEqual(a: string, b: string): boolean {
  return normaliseHash(a) === normaliseHash(b);
}

export function fallbackOptionsHash(info: TunnelInfo): string {
  return info.name ? computeOptionsHash({ name: info.name }) : 'v1:quick';
}

export function effectiveOptionsHash(
  info: TunnelInfo,
  meta: TunnelMetaEntry | undefined
): string {
  return meta?.optionsHash ?? fallbackOptionsHash(info);
}

export function tunnelConfigChanged(
  meta: TunnelMetaEntry | undefined,
  config: { accountId: string; zoneId: string }
): boolean {
  return (
    (meta?.accountId !== undefined && meta.accountId !== config.accountId) ||
    (meta?.zoneId !== undefined && meta.zoneId !== config.zoneId)
  );
}

export function namedTunnelInfoFromMeta(
  port: number,
  meta: TunnelMetaEntry | undefined
): NamedTunnelInfo | undefined {
  if (!meta?.needsRespawn || !meta.tunnelId || !meta.name || !meta.hostname) {
    return undefined;
  }
  return {
    id: meta.tunnelId,
    port,
    name: meta.name,
    hostname: meta.hostname,
    url: `https://${meta.hostname}`,
    createdAt: new Date().toISOString()
  };
}

export function createNamedTunnelCleanupEntry(
  info: TunnelInfo,
  meta: TunnelMetaEntry | undefined
): TunnelCleanupEntry | undefined {
  if (!info.name || !meta?.dnsRecordId) return undefined;
  return {
    tunnelId: info.id,
    port: info.port,
    name: info.name,
    hostname: info.hostname,
    dnsRecordId: meta.dnsRecordId,
    accountId: meta.accountId,
    zoneId: meta.zoneId,
    phase: 'claimed',
    updatedAt: new Date().toISOString()
  };
}

export function createNamedTunnelResourceIntent(args: {
  port: number;
  name: string;
  hostname: string;
  tunnelName: string;
  sandboxId: string;
  accountId: string;
  zoneId: string;
}): TunnelCleanupEntry {
  return {
    port: args.port,
    name: args.name,
    hostname: args.hostname,
    tunnelName: args.tunnelName,
    sandboxId: args.sandboxId,
    accountId: args.accountId,
    zoneId: args.zoneId,
    phase: 'planned',
    updatedAt: new Date().toISOString()
  };
}

export function namedRespawnMeta(
  info: NamedTunnelInfo,
  existing?: TunnelMetaEntry
): TunnelMetaEntry {
  return {
    optionsHash:
      existing?.optionsHash ?? computeOptionsHash({ name: info.name }),
    dnsRecordId: existing?.dnsRecordId,
    accountId: existing?.accountId,
    zoneId: existing?.zoneId,
    tunnelId: info.id,
    name: info.name,
    hostname: info.hostname,
    needsRespawn: true
  };
}

export function markCleanupTunnelReady(
  entry: TunnelCleanupEntry,
  tunnelId: string
): TunnelCleanupEntry {
  return {
    ...entry,
    tunnelId,
    phase: 'tunnel_ready',
    updatedAt: new Date().toISOString()
  };
}

export function markCleanupDNSReady(
  entry: TunnelCleanupEntry,
  dnsRecordId: string
): TunnelCleanupEntry {
  return {
    ...entry,
    dnsRecordId,
    phase: 'claimed',
    updatedAt: new Date().toISOString()
  };
}
