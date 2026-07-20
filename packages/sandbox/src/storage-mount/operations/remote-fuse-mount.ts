import type { BucketProvider, RemoteMountBucketOptions } from '@repo/shared';
import { getEnvString, logCanonicalEvent } from '@repo/shared';
import type { MountLifecycle } from '../lifecycle';
import { configureS3CredentialProxyOutbound } from '../outbound';
import { S3_CREDENTIAL_PROXY_HOST } from '../outbound/container-proxy';
import { buildS3CredentialProxyParams } from '../outbound/params';
import {
  evictDirectoryMarkerCacheForMount,
  evictSigV4ClientCacheEntry
} from '../outbound/s3-credential-proxy-handler';
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
import type { CredentialProxyAuthStrategy, FuseMountInfo } from '../types';
import { buildS3fsSource, validateRemoteMountOptions } from '../validation';
import { detectCredentials } from '../validation/credentials';
import { detectProviderFromUrl } from '../validation/provider';
import type { BucketMountOperationContext } from './context';
import { unmountFuseIfMountedForCleanup } from './fuse-cleanup';

export interface RemoteFuseMountContext extends BucketMountOperationContext {
  getEnv(): unknown;
  getEnvVars(): Record<string, string>;
  getR2AccessKeyID(): string | null;
  getR2SecretAccessKey(): string | null;
  lifecycle: MountLifecycle;
}

export async function mountRemoteFuseBucket(
  context: RemoteFuseMountContext,
  bucket: string,
  mountPath: string,
  options: RemoteMountBucketOptions
): Promise<void> {
  const mountStartTime = Date.now();
  const prefix = options.prefix;
  let mountOutcome: 'success' | 'error' = 'error';
  let mountError: Error | undefined;
  let passwordFilePath: string | undefined;
  let additionalHeaderFilePath: string | undefined;
  let provider: BucketProvider | null = null;
  let dirExisted = true;
  let credentialProxyEnabled = false;
  let credentialProxyMountId: string | undefined;
  let mountInfo: FuseMountInfo | undefined;
  try {
    validateRemoteMountOptions(
      context.registry.activeMounts,
      bucket,
      mountPath,
      {
        ...options,
        prefix
      }
    );

    const s3fsSource = buildS3fsSource(bucket, prefix);
    provider = options.provider || detectProviderFromUrl(options.endpoint);

    context.logger.debug(`Detected provider: ${provider || 'unknown'}`, {
      explicitProvider: options.provider,
      prefix
    });

    const envObj = context.getEnv() as Record<string, unknown>;
    const envCredentials = {
      AWS_ACCESS_KEY_ID: getEnvString(envObj, 'AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: getEnvString(envObj, 'AWS_SECRET_ACCESS_KEY'),
      R2_ACCESS_KEY_ID: context.getR2AccessKeyID() || undefined,
      R2_SECRET_ACCESS_KEY: context.getR2SecretAccessKey() || undefined
    };
    const credentials = detectCredentials(options, {
      ...envCredentials,
      ...context.getEnvVars()
    });

    credentialProxyEnabled = options.credentialProxy === true;
    if (credentialProxyEnabled) {
      validateProtectedS3fsOptions(options.s3fsOptions, 'credential proxy', [
        'ahbe_conf',
        'use_path_request_style'
      ]);
    }

    passwordFilePath = generatePasswordFilePath();
    if (credentialProxyEnabled) {
      additionalHeaderFilePath = generateS3FSAdditionalHeaderFilePath();
    }

    const mountId = crypto.randomUUID();
    credentialProxyMountId = mountId;
    mountInfo = {
      mountId,
      mountType: 'fuse',
      bucket: s3fsSource,
      mountPath,
      endpoint: options.endpoint,
      provider,
      passwordFilePath,
      ...(additionalHeaderFilePath ? { additionalHeaderFilePath } : {}),
      mounted: false,
      ...(credentialProxyEnabled
        ? {
            credentialProxy: {
              endpoint: options.endpoint,
              bucket,
              ...(prefix !== undefined ? { prefix } : {}),
              credentials,
              readOnly: options.readOnly ?? false,
              provider,
              authStrategy: resolveCredentialProxyAuthStrategy(provider)
            }
          }
        : {})
    };
    const lifecycle = await context.lifecycle.capture();

    await createPasswordFile(
      context.s3fsHost,
      passwordFilePath,
      bucket,
      credentialProxyEnabled
        ? { accessKeyId: 'x', secretAccessKey: 'x' }
        : credentials
    );
    if (credentialProxyEnabled) {
      if (additionalHeaderFilePath) {
        await createDisableExpectHeaderFile(
          context.s3fsHost,
          additionalHeaderFilePath
        );
      }
      await configureS3CredentialProxyOutbound(
        context.getOutboundHost(),
        buildS3CredentialProxyParams(context.registry, {
          includeMount: mountInfo
        })
      );
    }

    dirExisted = await context.runRuntimeCall('mount.pathExists', (control) =>
      control.mounts.pathExists(mountPath)
    );
    await context.runRuntimeCall('mount.ensureDirectory', (control) =>
      control.mounts.ensureDirectory(mountPath)
    );

    const effectiveOptions: RemoteMountBucketOptions = credentialProxyEnabled
      ? {
          ...options,
          endpoint: `http://${S3_CREDENTIAL_PROXY_HOST}/${mountId}`,
          s3fsOptions: [
            ...(provider === 'r2' ? R2_DEFAULT_S3FS_OPTION_ENTRIES : []),
            ...(options.s3fsOptions ?? []),
            ...(additionalHeaderFilePath
              ? [`ahbe_conf=${additionalHeaderFilePath}`]
              : []),
            'use_path_request_style'
          ]
        }
      : options;
    await executeS3FSMount(context.s3fsHost, {
      bucket: s3fsSource,
      mountPath,
      options: effectiveOptions,
      provider,
      passwordFilePath
    });

    await context.lifecycle.assertCurrent(lifecycle);
    mountInfo.mounted = true;
    context.registry.set(mountPath, mountInfo);
    mountOutcome = 'success';
  } catch (error) {
    mountError = error instanceof Error ? error : new Error(String(error));
    let supportFilesSafeToDelete = false;
    try {
      supportFilesSafeToDelete = await unmountFuseIfMountedForCleanup(
        context,
        mountPath
      );
    } catch (cleanupError) {
      context.logger.warn('FUSE mount cleanup check failed', {
        mountPath,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
      });
    }

    if (supportFilesSafeToDelete) {
      if (passwordFilePath) {
        await deletePasswordFile(context.s3fsHost, passwordFilePath);
      }
      if (additionalHeaderFilePath) {
        await deleteAdditionalHeaderFile(
          context.s3fsHost,
          additionalHeaderFilePath
        );
      }
    }

    if (!dirExisted) {
      try {
        await context.runRuntimeCall('mount.removeMountDirectory', (control) =>
          control.mounts.removeMountDirectory({
            path: mountPath,
            onlyIfNotMountpoint: false
          })
        );
      } catch {
        // best-effort cleanup
      }
    }

    const failedMount = context.registry.get(mountPath);
    if (failedMount?.mountType === 'fuse' && failedMount.credentialProxy) {
      await configureS3CredentialProxyOutbound(
        context.getOutboundHost(),
        buildS3CredentialProxyParams(context.registry, {
          excludeMountId: failedMount.mountId
        })
      );
      context.registry.delete(mountPath);
      evictSigV4ClientCacheEntry(failedMount.mountId);
      evictDirectoryMarkerCacheForMount(failedMount.mountId);
    } else {
      if (credentialProxyEnabled) {
        try {
          await configureS3CredentialProxyOutbound(
            context.getOutboundHost(),
            buildS3CredentialProxyParams(context.registry)
          );
        } catch (cleanupError) {
          if (mountInfo) {
            mountInfo.mounted = !supportFilesSafeToDelete;
            context.registry.set(mountPath, mountInfo);
          }
          throw new Error(
            `Credential proxy mount failed and outbound cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; original mount error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (credentialProxyMountId) {
          evictSigV4ClientCacheEntry(credentialProxyMountId);
          evictDirectoryMarkerCacheForMount(credentialProxyMountId);
        }
      }
      context.registry.delete(mountPath);
    }
    throw error;
  } finally {
    logCanonicalEvent(context.logger, {
      event: 'bucket.mount',
      outcome: mountOutcome,
      durationMs: Date.now() - mountStartTime,
      bucket,
      mountPath,
      provider: provider || 'unknown',
      prefix,
      error: mountError
    });
  }
}

function resolveCredentialProxyAuthStrategy(
  provider: BucketProvider | null
): CredentialProxyAuthStrategy {
  return provider === 'gcs' ? 'gcs' : 's3-sigv4';
}
