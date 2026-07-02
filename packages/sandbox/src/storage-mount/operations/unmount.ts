import { logCanonicalEvent, shellEscape } from '@repo/shared';
import { BucketUnmountError, InvalidMountConfigError } from '../errors';
import {
  configureR2EgressOutbound,
  configureS3CredentialProxyOutbound
} from '../outbound';
import {
  buildR2EgressParams,
  buildS3CredentialProxyParams
} from '../outbound/params';
import {
  evictDirectoryMarkerCacheForMount,
  evictSigV4ClientCacheEntry
} from '../outbound/s3-credential-proxy-handler';
import { deleteAdditionalHeaderFile, deletePasswordFile } from '../s3fs';
import type { BucketMountOperationContext } from './context';

export async function unmountBucketOperation(
  context: BucketMountOperationContext,
  mountPath: string
): Promise<void> {
  const unmountStartTime = Date.now();
  let unmountOutcome: 'success' | 'error' = 'error';
  let unmountError: Error | undefined;
  const mountInfo = context.registry.get(mountPath);

  try {
    if (!mountInfo) {
      throw new InvalidMountConfigError(
        `No active mount found at path: ${mountPath}`
      );
    }

    if (mountInfo.mountType === 'local-sync') {
      await mountInfo.syncManager.stop();
      mountInfo.mounted = false;
      context.registry.delete(mountPath);
    } else {
      let unmounted = !mountInfo.mounted;
      if (mountInfo.mounted) {
        const result = await context.execInternal(
          `fusermount -u ${shellEscape(mountPath)}`
        );
        if (result.exitCode !== 0) {
          const stderr = result.stderr || 'unknown error';
          throw new BucketUnmountError(
            `fusermount -u failed (exit ${result.exitCode}): ${stderr}`
          );
        }
        mountInfo.mounted = false;
        unmounted = true;
      }

      if (mountInfo.mountType === 'r2-egress') {
        await configureR2EgressOutbound(
          context.getOutboundHost(),
          buildR2EgressParams(context.registry, {
            excludeMountId: mountInfo.mountId
          })
        );
      } else if (mountInfo.mountType === 'fuse' && mountInfo.credentialProxy) {
        await configureS3CredentialProxyOutbound(
          context.getOutboundHost(),
          buildS3CredentialProxyParams(context.registry, {
            excludeMountId: mountInfo.mountId
          })
        );
        evictSigV4ClientCacheEntry(mountInfo.mountId);
        evictDirectoryMarkerCacheForMount(mountInfo.mountId);
      }

      context.registry.delete(mountPath);

      try {
        const cleanup = await context.execInternal(
          `mountpoint -q ${shellEscape(mountPath)} || rmdir ${shellEscape(mountPath)}`
        );
        if (cleanup.exitCode !== 0) {
          context.logger.warn('mount directory removal failed', {
            mountPath,
            exitCode: cleanup.exitCode,
            stderr: cleanup.stderr
          });
        }
      } catch (err) {
        context.logger.warn('mount directory removal failed', {
          mountPath,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      if (unmounted) {
        await deletePasswordFile(
          context.getS3FSHost(),
          mountInfo.passwordFilePath
        );
        if (mountInfo.additionalHeaderFilePath) {
          await deleteAdditionalHeaderFile(
            context.getS3FSHost(),
            mountInfo.additionalHeaderFilePath
          );
        }
      }
    }

    unmountOutcome = 'success';
  } catch (error) {
    unmountError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    logCanonicalEvent(context.logger, {
      event: 'bucket.unmount',
      outcome: unmountOutcome,
      durationMs: Date.now() - unmountStartTime,
      mountPath,
      bucket: mountInfo?.bucket,
      error: unmountError
    });
  }
}
