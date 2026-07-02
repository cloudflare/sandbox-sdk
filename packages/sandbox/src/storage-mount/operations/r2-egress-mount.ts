import type { R2BindingMountBucketOptions } from '@repo/shared';
import { logCanonicalEvent, shellEscape } from '@repo/shared';
import { InvalidMountConfigError } from '../errors';
import type { MountLifecycle } from '../lifecycle';
import { configureR2EgressOutbound } from '../outbound';
import { buildR2EgressParams } from '../outbound/params';
import {
  createDisableExpectHeaderFile,
  createPasswordFile,
  deleteAdditionalHeaderFile,
  deletePasswordFile,
  executeS3FSMount,
  generatePasswordFilePath,
  generateS3FSAdditionalHeaderFilePath,
  R2_DEFAULT_S3FS_OPTION_ENTRIES,
  validateProtectedS3fsOptions
} from '../s3fs';
import type { R2BindingMountInfo } from '../types';
import { validateBucketBindingName, validateMountPath } from '../validation';
import type { BucketMountOperationContext } from './context';
import { unmountFuseIfMountedForCleanup } from './fuse-cleanup';

export interface R2EgressMountContext extends BucketMountOperationContext {
  lifecycle: MountLifecycle;
}

export async function mountR2EgressBucket(
  context: R2EgressMountContext,
  bucket: string,
  mountPath: string,
  options: R2BindingMountBucketOptions
): Promise<void> {
  const mountStartTime = Date.now();
  const prefix = options.prefix;
  let mountOutcome: 'success' | 'error' = 'error';
  let mountError: Error | undefined;
  let passwordFilePath: string | undefined;
  let additionalHeaderFilePath: string | undefined;
  let s3fsStarted = false;
  let mountInfo: R2BindingMountInfo | undefined;

  try {
    validateBucketBindingName(bucket, mountPath);
    validateMountPath(context.registry.activeMounts, mountPath);
    validateProtectedS3fsOptions(options.s3fsOptions, 'R2 binding');

    for (const [existingMountPath, existingMount] of context.registry) {
      if (
        existingMount.mountType === 'r2-egress' &&
        existingMount.bucket === bucket &&
        existingMount.prefix !== prefix
      ) {
        throw new InvalidMountConfigError(
          `R2 binding "${bucket}" is already mounted at ${existingMountPath} with a different prefix. ` +
            'Mount the same binding only once, or use the same prefix for additional mounts.'
        );
      }
      if (
        existingMount.mountType === 'r2-egress' &&
        existingMount.bucket === bucket &&
        existingMount.readOnly !== (options.readOnly ?? false)
      ) {
        throw new InvalidMountConfigError(
          `R2 binding "${bucket}" is already mounted at ${existingMountPath} with a different readOnly setting. ` +
            'Mount the same binding only once, or use the same readOnly value for additional mounts.'
        );
      }
    }

    const lifecycle = await context.lifecycle.capture();
    passwordFilePath = generatePasswordFilePath();
    additionalHeaderFilePath = generateS3FSAdditionalHeaderFilePath();
    await createPasswordFile(context.getS3FSHost(), passwordFilePath, bucket, {
      accessKeyId: 'x',
      secretAccessKey: 'x'
    });
    await createDisableExpectHeaderFile(
      context.getS3FSHost(),
      additionalHeaderFilePath
    );

    mountInfo = {
      mountId: crypto.randomUUID(),
      mountType: 'r2-egress',
      bucket,
      mountPath,
      passwordFilePath,
      additionalHeaderFilePath,
      mounted: false,
      prefix,
      readOnly: options.readOnly ?? false
    };
    await configureR2EgressOutbound(context.getOutboundHost(), {
      buckets: {
        ...buildR2EgressParams(context.registry).buckets,
        [bucket]: {
          prefix,
          readOnly: options.readOnly ?? false
        }
      }
    });

    await context.execInternal(`mkdir -p ${shellEscape(mountPath)}`);

    s3fsStarted = true;
    await executeS3FSMount(context.getS3FSHost(), {
      bucket,
      mountPath,
      provider: 'r2',
      passwordFilePath,
      options: {
        ...options,
        endpoint: 'http://r2.internal',
        s3fsOptions: [
          ...R2_DEFAULT_S3FS_OPTION_ENTRIES,
          ...(options.s3fsOptions ?? []),
          'use_path_request_style',
          `ahbe_conf=${additionalHeaderFilePath}`
        ]
      }
    });

    await context.lifecycle.assertCurrent(lifecycle);
    mountInfo.mounted = true;
    context.registry.set(mountPath, mountInfo);
    mountOutcome = 'success';
  } catch (error) {
    mountError = error instanceof Error ? error : new Error(String(error));
    const failedMount = context.registry.get(mountPath);
    context.registry.delete(mountPath);
    let supportFilesSafeToDelete = !s3fsStarted;
    if (s3fsStarted) {
      try {
        supportFilesSafeToDelete = await unmountFuseIfMountedForCleanup(
          context,
          mountPath
        );
      } catch (cleanupError) {
        context.logger.warn('R2 egress FUSE mount cleanup check failed', {
          mountPath,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
        });
      }
    }

    if (supportFilesSafeToDelete) {
      const cleanupPasswordFilePath =
        failedMount?.mountType === 'r2-egress'
          ? failedMount.passwordFilePath
          : passwordFilePath;
      const cleanupAdditionalHeaderFilePath =
        failedMount?.mountType === 'r2-egress'
          ? failedMount.additionalHeaderFilePath
          : additionalHeaderFilePath;

      if (cleanupPasswordFilePath) {
        await deletePasswordFile(
          context.getS3FSHost(),
          cleanupPasswordFilePath
        ).catch(() => {});
      }
      if (cleanupAdditionalHeaderFilePath) {
        await deleteAdditionalHeaderFile(
          context.getS3FSHost(),
          cleanupAdditionalHeaderFilePath
        ).catch(() => {});
      }
    }

    try {
      await configureR2EgressOutbound(
        context.getOutboundHost(),
        buildR2EgressParams(context.registry)
      );
    } catch (cleanupError) {
      if (mountInfo) {
        mountInfo.mounted = !supportFilesSafeToDelete;
        context.registry.set(mountPath, mountInfo);
      }
      throw new Error(
        `R2 egress mount failed and outbound cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; original mount error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  } finally {
    logCanonicalEvent(context.logger, {
      event: 'bucket.mount',
      outcome: mountOutcome,
      durationMs: Date.now() - mountStartTime,
      bucket,
      mountPath,
      provider: 'r2',
      prefix,
      error: mountError
    });
  }
}
