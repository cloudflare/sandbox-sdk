import type { Logger } from '@repo/shared';
import {
  configureR2EgressOutbound,
  configureS3CredentialProxyOutbound,
  type MountOutboundHost
} from './outbound';
import {
  buildR2EgressParams,
  buildS3CredentialProxyParams
} from './outbound/params';
import {
  evictDirectoryMarkerCacheForMount,
  evictSigV4ClientCacheEntry
} from './outbound/s3-credential-proxy-handler';
import type { MountRegistry } from './registry';
import {
  deleteAdditionalHeaderFile,
  deletePasswordFile,
  type S3FSHost,
  unmountTrackedFuseMount
} from './s3fs';

export interface BucketMountDestroyCleanupResult {
  mountsProcessed: number;
  mountFailures: number;
}

export interface BucketMountLifecycleCleanupHost {
  registry: MountRegistry;
  logger: Logger;
  s3fsHost: S3FSHost | null;
  getOutboundHost(): MountOutboundHost;
  runMountOperation<T>(operation: () => Promise<T>): Promise<T>;
}

export async function cleanupBucketMountsForDestroy(
  host: BucketMountLifecycleCleanupHost
): Promise<BucketMountDestroyCleanupResult> {
  return host.runMountOperation(async () => {
    let mountsProcessed = 0;
    let mountFailures = 0;

    const cleanedMountPaths: string[] = [];
    const cleanedMountIds: string[] = [];
    let hadR2EgressMount = false;
    let hadCredentialProxyMount = false;

    for (const [mountPath, mountInfo] of host.registry.entries()) {
      mountsProcessed++;
      if (mountInfo.mountType === 'local-sync') {
        try {
          if (host.s3fsHost) {
            await mountInfo.syncManager.stop();
          } else {
            mountInfo.syncManager.interrupt();
          }
          mountInfo.mounted = false;
          cleanedMountPaths.push(mountPath);
          cleanedMountIds.push(mountInfo.mountId);
        } catch (error) {
          mountFailures++;
          host.logger.warn(
            `Failed to stop local sync for ${mountPath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        if (mountInfo.mountType === 'r2-egress') {
          hadR2EgressMount = true;
        } else if (
          mountInfo.mountType === 'fuse' &&
          mountInfo.credentialProxy
        ) {
          hadCredentialProxyMount = true;
        }

        let supportFilesSafeToDelete = false;
        if (host.s3fsHost) {
          try {
            supportFilesSafeToDelete = await unmountTrackedFuseMount(
              host.s3fsHost,
              mountPath,
              mountInfo
            );
          } catch (error) {
            mountFailures++;
            host.logger.warn(
              `Failed to unmount bucket ${mountInfo.bucket} from ${mountPath}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          if (supportFilesSafeToDelete) {
            await deletePasswordFile(host.s3fsHost, mountInfo.passwordFilePath);
            if (mountInfo.additionalHeaderFilePath) {
              await deleteAdditionalHeaderFile(
                host.s3fsHost,
                mountInfo.additionalHeaderFilePath
              );
            }
          }
        } else if (mountInfo.mounted) {
          mountFailures++;
        }

        cleanedMountPaths.push(mountPath);
        cleanedMountIds.push(mountInfo.mountId);

        if (mountInfo.mountType === 'fuse' && mountInfo.credentialProxy) {
          evictSigV4ClientCacheEntry(mountInfo.mountId);
          evictDirectoryMarkerCacheForMount(mountInfo.mountId);
        }
      }
    }

    if (hadR2EgressMount) {
      try {
        await configureR2EgressOutbound(
          host.getOutboundHost(),
          buildR2EgressParams(host.registry, {
            excludeMountIds: cleanedMountIds
          })
        );
      } catch (error) {
        mountFailures++;
        host.logger.warn(
          `Failed to update R2 egress outbound configuration during destroy cleanup: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (hadCredentialProxyMount) {
      try {
        await configureS3CredentialProxyOutbound(
          host.getOutboundHost(),
          buildS3CredentialProxyParams(host.registry, {
            excludeMountIds: cleanedMountIds
          })
        );
      } catch (error) {
        mountFailures++;
        host.logger.warn(
          `Failed to update credential proxy outbound configuration during destroy cleanup: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    for (const mountPath of cleanedMountPaths) {
      host.registry.delete(mountPath);
    }

    return { mountsProcessed, mountFailures };
  });
}

export async function cleanupBucketMountsForStop(
  host: BucketMountLifecycleCleanupHost
): Promise<void> {
  return host.runMountOperation(async () => {
    let hadR2EgressMount = false;
    let hadCredentialProxyMount = false;
    for (const [, mountInfo] of host.registry) {
      if (mountInfo.mountType === 'local-sync') {
        mountInfo.syncManager.interrupt();
      } else if (mountInfo.mountType === 'r2-egress') {
        hadR2EgressMount = true;
      } else if (mountInfo.mountType === 'fuse' && mountInfo.credentialProxy) {
        hadCredentialProxyMount = true;
        evictSigV4ClientCacheEntry(mountInfo.mountId);
        evictDirectoryMarkerCacheForMount(mountInfo.mountId);
      }
    }
    if (hadR2EgressMount) {
      await configureR2EgressOutbound(host.getOutboundHost(), {
        buckets: {}
      }).catch(() => {});
    }
    if (hadCredentialProxyMount) {
      await configureS3CredentialProxyOutbound(host.getOutboundHost(), {
        mounts: {}
      }).catch(() => {});
    }
    host.registry.clear();
  });
}
