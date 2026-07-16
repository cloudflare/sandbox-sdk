import { getSandbox } from '@cloudflare/sandbox';

import {
  checkpointFromMetadata,
  createDirectoryBackup,
  shouldUseLocalBucket
} from './backup';
import type { BackupMetadata, Checkpoint } from './types';

export async function handleExec(
  request: Request,
  env: Env
): Promise<Response> {
  const { command } = await request.json<{ command: string }>();
  if (!command) {
    return Response.json({ error: 'Missing command' }, { status: 400 });
  }

  try {
    const sandbox = getSandbox(env.Sandbox, 'time-machine');
    const proc = await sandbox.exec(['/bin/bash', '-lc', command]);
    const result = await proc.output();

    return Response.json({
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      exitCode: result.exitCode
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Command execution failed';
    return Response.json({
      stdout: '',
      stderr: message,
      exitCode: 1
    });
  }
}

export async function handleSaveCheckpoint(
  request: Request,
  env: Env
): Promise<Response> {
  const { name } = await request.json<{ name?: string }>();
  const checkpointName = name || `checkpoint-${Date.now()}`;

  const sandbox = getSandbox(env.Sandbox, 'time-machine');
  const useLocalBucket = shouldUseLocalBucket(
    env.USE_LOCAL_BUCKET_BACKUPS || ''
  );

  // createBackup stores archive + meta.json in R2
  // The meta.json includes { id, dir, name, sizeBytes, ttl, createdAt }
  const backup = await sandbox.createBackup({
    dir: '/workspace',
    name: checkpointName,
    ttl: 24 * 60 * 60,
    ...(useLocalBucket ? { localBucket: true } : {})
  });

  // Return checkpoint info from the backup response
  const checkpoint: Checkpoint = {
    id: backup.id,
    name: checkpointName,
    createdAt: new Date().toISOString(),
    dir: backup.dir
  };

  return Response.json({ checkpoint });
}

export async function handleRestore(
  request: Request,
  env: Env
): Promise<Response> {
  const { id } = await request.json<{ id: string }>();
  if (!id) {
    return Response.json({ error: 'Missing checkpoint id' }, { status: 400 });
  }

  // Read metadata from R2 to get the dir
  const metaKey = `backups/${id}/meta.json`;
  const metaObj = await env.BACKUP_BUCKET.get(metaKey);
  if (!metaObj) {
    return Response.json({ error: 'Checkpoint not found' }, { status: 404 });
  }

  const meta = await metaObj.json<BackupMetadata>();
  const useLocalBucket = shouldUseLocalBucket(
    env.USE_LOCAL_BUCKET_BACKUPS || ''
  );
  const backup = createDirectoryBackup(meta, useLocalBucket);

  const sandbox = getSandbox(env.Sandbox, 'time-machine');
  await sandbox.restoreBackup(backup);

  const checkpoint = checkpointFromMetadata(meta);

  return Response.json({ restored: checkpoint });
}

export async function handleListCheckpoints(env: Env): Promise<Response> {
  // List all meta.json files in the backups/ prefix
  const listed = await env.BACKUP_BUCKET.list({
    prefix: 'backups/'
  });

  // Filter to only meta.json files and fetch each
  const metaKeys = listed.objects
    .filter((obj) => obj.key.endsWith('/meta.json'))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime()) // newest first
    .slice(0, 20); // limit to 20

  const checkpoints: Checkpoint[] = [];
  for (const obj of metaKeys) {
    const metaObj = await env.BACKUP_BUCKET.get(obj.key);
    if (metaObj) {
      const meta = await metaObj.json<BackupMetadata>();
      checkpoints.push(checkpointFromMetadata(meta));
    }
  }

  return Response.json({ checkpoints });
}
