import type { LocalMountBucketOptions } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import { LocalMountSyncManager } from '../../local-mount-sync';
import { InvalidMountConfigError } from '../errors';
import type { MountLifecycle } from '../lifecycle';
import type { MountRegistry } from '../registry';
import type { MountRuntimeLease } from '../runtime-call';
import type { S3FSHost } from '../s3fs';
import type { LocalSyncMountInfo } from '../types';
import { isR2Bucket } from '../validation';
import type { BucketMountOperationContext } from './context';

export interface LocalSyncMountContext extends BucketMountOperationContext {
  getEnv(): unknown;
  lifecycle: MountLifecycle;
  runtime: MountRuntimeLease['runtime'];
  s3fsHost: S3FSHost;
  retainRuntime: MountRuntimeLease['retain'];
}

export function validateLocalSyncMount(
  context: Pick<LocalSyncMountContext, 'getEnv' | 'registry'>,
  bucket: string,
  mountPath: string
): R2Bucket {
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
  return r2Binding;
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
    const r2Binding = validateLocalSyncMount(context, bucket, mountPath);

    let syncManager: LocalMountSyncManager | null = null;
    const runtimeHold = context.retainRuntime(() => {
      syncManager?.interrupt();
    });
    syncManager = new LocalMountSyncManager({
      bucket: r2Binding,
      mountPath,
      prefix: options.prefix,
      readOnly: options.readOnly ?? false,
      runRuntimeCall: context.runRuntimeCall,
      runtimeHold,
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
    const lifecycle = await context.lifecycle.capture(context.runtime);
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
