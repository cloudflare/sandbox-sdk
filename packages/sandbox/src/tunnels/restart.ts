import {
  META_STORAGE_KEY,
  readMap,
  readMetaMap,
  STORAGE_KEY,
  type TunnelMap,
  type TunnelMetaMap,
  type TunnelsStorage
} from './storage';

export async function pruneTunnelsForRestart(
  storage: TunnelsStorage
): Promise<void> {
  await storage.transaction(async (txn) => {
    const map = await readMap(txn);
    const meta = await readMetaMap(txn);
    const nextMap: TunnelMap = {};
    const nextMeta: TunnelMetaMap = {};
    for (const [portKey, info] of Object.entries(map)) {
      if (info.name) {
        nextMap[portKey] = info;
        nextMeta[portKey] = {
          ...(meta[portKey] ?? { optionsHash: `v1:named:${info.name}` }),
          needsRespawn: true
        };
      }
    }
    await txn.put(STORAGE_KEY, nextMap);
    await txn.put(META_STORAGE_KEY, nextMeta);
  });
}
