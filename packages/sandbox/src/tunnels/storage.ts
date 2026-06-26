import type { TunnelInfo, TunnelOptions } from '@repo/shared';
import type { RuntimeIdentityID } from '../current-runtime-identity';
import type { SandboxLifetimeID } from '../sandbox-lifetime';

export const STORAGE_KEY = 'tunnels';
export const META_STORAGE_KEY = 'tunnels:meta';

export interface TunnelsStorageTxn {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface TunnelsStorage extends TunnelsStorageTxn {
  transaction<T>(closure: (txn: TunnelsStorageTxn) => Promise<T>): Promise<T>;
}

export type TunnelMap = Record<string, TunnelInfo>;

export interface TunnelMetaEntry {
  optionsHash: string;
  dnsRecordId?: string;
  runtimeIdentityID?: RuntimeIdentityID;
  sandboxLifetimeID?: SandboxLifetimeID;
  tunnelRunId?: string;
  accountId?: string;
  zoneId?: string;
  needsRespawn?: boolean;
}

export type TunnelMetaMap = Record<string, TunnelMetaEntry>;

export async function readMap(storage: TunnelsStorageTxn): Promise<TunnelMap> {
  return (await storage.get<TunnelMap>(STORAGE_KEY)) ?? {};
}

export async function readMetaMap(
  storage: TunnelsStorageTxn
): Promise<TunnelMetaMap> {
  return (await storage.get<TunnelMetaMap>(META_STORAGE_KEY)) ?? {};
}

export function computeOptionsHash(options?: TunnelOptions): string {
  if (!options || !options.name) return 'v1:quick';
  return `v1:named:${options.name}`;
}

function normaliseHash(hash: string): string {
  return hash.startsWith('v1:') ? hash.slice(3) : hash;
}

export function optionsHashesEqual(a: string, b: string): boolean {
  return normaliseHash(a) === normaliseHash(b);
}
