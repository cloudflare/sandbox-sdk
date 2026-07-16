import type { DirectoryBackup } from '@cloudflare/sandbox';

import type { BackupMetadata, Checkpoint } from './types';

export function shouldUseLocalBucket(value: string): boolean {
  return (
    typeof value === 'string' &&
    ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
  );
}

export function createDirectoryBackup(
  meta: BackupMetadata,
  useLocalBucket: boolean
): DirectoryBackup {
  return useLocalBucket
    ? { id: meta.id, dir: meta.dir, localBucket: true }
    : { id: meta.id, dir: meta.dir };
}

export function checkpointFromMetadata(meta: BackupMetadata): Checkpoint {
  return {
    id: meta.id,
    name: meta.name || `checkpoint-${meta.id.slice(0, 8)}`,
    createdAt: meta.createdAt,
    dir: meta.dir
  };
}
