import type { LocalMountBucketOptions } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import type { ContainerControlClient } from '../../container-control';
import { LocalMountSyncManager } from '../../local-mount-sync';
import { InvalidMountConfigError } from '../errors';
import type { MountLifecycle } from '../lifecycle';
import type { MountRegistry } from '../registry';
import type { LocalSyncMountInfo } from '../types';
import { isR2Bucket } from '../validation';
import type { BucketMountOperationContext } from './context';

export interface LocalSyncMountContext extends BucketMountOperationContext {
  getEnv(): unknown;
  getClient(): ContainerControlClient;
  lifecycle: MountLifecycle;
}

export async function mountLocalSyncBucket(
  context: LocalSyncMountContext,
  bucket: string,
  mountPath: string,
  options: LocalMountBucketOptions
): Promise<void> {
  const mountStartTime = Date.now();
  let mountOutcome: 'success' | 'error' = 'error';
  let mountError: Error | undefined;
  try {
    const envObj = context.getEnv() as Record<string, unknown>;
    const r2Binding = envObj[bucket];
    if (!r2Binding || !isR2Bucket(r2Binding)) {
      throw new InvalidMountConfigError(
        `R2 binding "${bucket}" not found in env or is not an R2Bucket. ` +
          'Make sure the binding name matches your wrangler.jsonc R2 binding.'
      );
    }

    if (!mountPath || !mountPath.startsWith('/')) {
      throw new InvalidMountConfigError(
        `Invalid mount path: "${mountPath}". Must be an absolute path starting with /`
      );
    }

    if (context.registry.has(mountPath)) {
      throw new InvalidMountConfigError(
        `Mount path already in use: ${mountPath}`
      );
    }

    const syncManager = new LocalMountSyncManager({
      bucket: r2Binding,
      mountPath,
      prefix: options.prefix,
      readOnly: options.readOnly ?? false,
      client: context.getClient(),
      logger: context.logger
    });

    const mountInfo: LocalSyncMountInfo = {
      mountId: crypto.randomUUID(),
      mountType: 'local-sync',
      bucket,
      mountPath,
      syncManager,
      mounted: false
    };
    const lifecycle = await context.lifecycle.capture();
    try {
      await syncManager.start();
      await context.lifecycle.assertCurrent(lifecycle);
      mountInfo.mounted = true;
      context.registry.set(mountPath, mountInfo);
    } catch (error) {
      await syncManager.stop();
      throw error;
    }

    mountOutcome = 'success';
  } catch (error) {
    mountError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    logCanonicalEvent(context.logger, {
      event: 'bucket.mount',
      outcome: mountOutcome,
      durationMs: Date.now() - mountStartTime,
      bucket,
      mountPath,
      provider: 'local-sync',
      prefix: options.prefix,
      error: mountError
    });
  }
}
