import type { R2BindingMountBucketOptions } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import { InvalidMountConfigError } from '../errors';
import type { MountLifecycle } from '../lifecycle';
import { configureR2EgressOutbound } from '../outbound';
import { buildR2EgressParams } from '../outbound/params';
import type { MountRuntimeLease } from '../runtime-call';
import type { S3FSHost } from '../s3fs';
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
  runtime: MountRuntimeLease['runtime'];
  s3fsHost: S3FSHost;
}

export function validateR2EgressMount(
  context: Pick<R2EgressMountContext, 'registry' | 'getOutboundHost'>,
  bucket: string,
  mountPath: string,
  options: R2BindingMountBucketOptions
): void {
  const prefix = options.prefix;
  validateBucketBindingName(bucket, mountPath);
  validateMountPath(context.registry.activeMounts, mountPath);
  validateProtectedS3fsOptions(options.s3fsOptions, 'R2 binding');

  // A mount from before a Durable Object restart is not in the registry, but
  // its s3fs process still uses the binding's route.
  const restoredRoute =
    context.getOutboundHost().restoredMountRoutes.r2Buckets[bucket];
  if (
    restoredRoute &&
    (restoredRoute.prefix !== prefix ||
      (restoredRoute.readOnly ?? false) !== (options.readOnly ?? false))
  ) {
    throw new InvalidMountConfigError(
      `R2 binding "${bucket}" is already mounted with a different prefix or readOnly setting. ` +
        'Mount the same binding only once, or use the same settings for additional mounts.'
    );
  }

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
    validateR2EgressMount(context, bucket, mountPath, options);

    const lifecycle = await context.lifecycle.capture(context.runtime);
    passwordFilePath = generatePasswordFilePath();
    additionalHeaderFilePath = generateS3FSAdditionalHeaderFilePath();
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

    // Mounts run one at a time, so each round trip here adds to every later
    // mount. These steps are independent; only s3fs needs all of them.
    await allOrFirstError([
      createPasswordFile(context.s3fsHost, passwordFilePath, bucket, {
        accessKeyId: 'x',
        secretAccessKey: 'x'
      }),
      createDisableExpectHeaderFile(context.s3fsHost, additionalHeaderFilePath),
      configureR2EgressOutbound(context.getOutboundHost(), {
        buckets: {
          ...buildR2EgressParams(context.registry).buckets,
          [bucket]: {
            prefix,
            readOnly: options.readOnly ?? false
          }
        }
      }),
      context.runRuntimeCall('mount.ensureDirectory', (control) =>
        control.mounts.ensureDirectory(mountPath)
      )
    ]);

    s3fsStarted = true;
    await executeS3FSMount(context.s3fsHost, {
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
          context.s3fsHost,
          cleanupPasswordFilePath
        ).catch(() => {});
      }
      if (cleanupAdditionalHeaderFilePath) {
        await deleteAdditionalHeaderFile(
          context.s3fsHost,
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

/**
 * Like `Promise.all`, but waits for every step to settle before rejecting, so
 * cleanup never runs while a support-file write or route update is in flight.
 */
async function allOrFirstError(steps: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(steps);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failure) throw failure.reason;
}
