import {
  META_STORAGE_KEY,
  namedRespawnMeta,
  readMap,
  readMetaMap,
  STORAGE_KEY,
  type TunnelMap,
  type TunnelMetaEntry,
  type TunnelMetaMap,
  type TunnelsStorage
} from './storage';

/**
 * Reconcile storage with a fresh container.
 *
 * Called from `Sandbox.onStart()` after every container restart. The
 * `cloudflared` processes the container was running all died with it, so
 * any stored record is not currently backed by a running tunnel.
 *
 * Quick tunnels are dropped because the `*.trycloudflare.com` URL is bound
 * to the dead process. Named tunnels keep private metadata so a later
 * `get(port, { name })` can respawn cloudflared against the existing
 * Cloudflare tunnel and DNS record.
 */
function isHiddenNamedRespawnMeta(
  entry: TunnelMetaEntry | undefined
): entry is TunnelMetaEntry & {
  needsRespawn: true;
  tunnelId: string;
  name: string;
  hostname: string;
} {
  return (
    entry?.needsRespawn === true &&
    typeof entry.tunnelId === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.hostname === 'string'
  );
}

export async function pruneTunnelsForRestart(
  storage: TunnelsStorage
): Promise<void> {
  await storage.transaction(async (txn) => {
    const map = await readMap(txn);
    const meta = await readMetaMap(txn);
    const nextMap: TunnelMap = {};
    const nextMeta: TunnelMetaMap = {};
    for (const [portKey, info] of Object.entries(map)) {
      // Discriminate by the public `name` field on `TunnelInfo`: named
      // tunnels carry the user-provided label, quick tunnels omit it.
      if (info.name) {
        nextMeta[portKey] = namedRespawnMeta(info, meta[portKey]);
      }
    }
    for (const [portKey, entry] of Object.entries(meta)) {
      if (nextMeta[portKey] || !isHiddenNamedRespawnMeta(entry)) continue;
      nextMeta[portKey] = entry;
    }
    await txn.put(STORAGE_KEY, nextMap);
    await txn.put(META_STORAGE_KEY, nextMeta);
  });
}
