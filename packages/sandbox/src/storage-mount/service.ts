import type {
  LocalMountBucketOptions,
  Logger,
  MountBucketOptions,
  R2BindingMountBucketOptions,
  RemoteMountBucketOptions
} from '@repo/shared';
import type { ContainerControlClient } from '../container-control';
import type { CurrentRuntimeIdentity } from '../current-runtime-identity';
import type { CurrentSandboxLifetime } from '../sandbox-lifetime';
import { InvalidMountConfigError } from './errors';
import { MountLifecycle } from './lifecycle';
import {
  type BucketMountDestroyCleanupResult,
  cleanupBucketMountsForDestroy,
  cleanupBucketMountsForStop
} from './lifecycle-cleanup';
import { MountOperationQueue } from './operation-queue';
import { mountLocalSyncBucket } from './operations/local-sync-mount';
import { mountR2EgressBucket } from './operations/r2-egress-mount';
import { mountRemoteFuseBucket } from './operations/remote-fuse-mount';
import { unmountBucketOperation } from './operations/unmount';
import type { MountOutboundHost } from './outbound';
import { MountRegistry } from './registry';
import type { S3FSHost } from './s3fs';
import { isR2Bucket, validateBucketName, validatePrefix } from './validation';

export interface BucketMountServiceDeps {
  getEnv(): unknown;
  getEnvVars(): Record<string, string>;
  getClient(): ContainerControlClient;
  logger: Logger;
  currentRuntime: CurrentRuntimeIdentity;
  currentLifetime: CurrentSandboxLifetime;
  getR2AccessKeyID(): string | null;
  getR2SecretAccessKey(): string | null;
  getOutboundHost(): MountOutboundHost;
}

export class BucketMountService {
  private readonly registry = new MountRegistry();
  private readonly operations = new MountOperationQueue();
  private readonly lifecycle: MountLifecycle;

  constructor(private readonly deps: BucketMountServiceDeps) {
    this.lifecycle = new MountLifecycle(
      deps.currentRuntime,
      deps.currentLifetime
    );
  }

  private get client(): ContainerControlClient {
    return this.deps.getClient();
  }

  /**
   * Mount an S3-compatible bucket as a local directory.
   *
   * Requires explicit endpoint URL for production. Credentials are auto-detected from environment
   * variables or can be provided explicitly.
   *
   * @param bucket - Bucket name (or R2 binding name when localBucket is true)
   * @param mountPath - Absolute path in container to mount at
   * @param options - Mount configuration
   * @throws MissingCredentialsError if no credentials found in environment
   * @throws S3FSMountError if S3FS mount command fails
   * @throws InvalidMountConfigError if bucket name, mount path, or endpoint is invalid
   */
  async mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void> {
    return this.operations.run(async () => {
      await this.mountBucketUnlocked(bucket, mountPath, options);
    });
  }

  private async mountBucketUnlocked(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void> {
    if (options.prefix !== undefined) {
      validatePrefix(options.prefix);
    }

    if ('localBucket' in options && options.localBucket) {
      await this.mountBucketLocal(bucket, mountPath, options);
      return;
    }

    const remoteOptions = options as RemoteMountBucketOptions;
    if (remoteOptions.endpoint === undefined) {
      const envObj = this.deps.getEnv() as Record<string, unknown>;
      const binding = envObj[bucket];
      if (isR2Bucket(binding)) {
        await this.mountBucketR2Egress(
          bucket,
          mountPath,
          options as R2BindingMountBucketOptions
        );
        return;
      }
      throw new InvalidMountConfigError(
        `R2 binding "${bucket}" not found in Worker env. ` +
          'Ensure the binding name matches the bucket binding configured in wrangler.jsonc.'
      );
    }

    await this.mountBucketFuse(bucket, mountPath, remoteOptions);
  }

  private async mountBucketLocal(
    bucket: string,
    mountPath: string,
    options: LocalMountBucketOptions
  ): Promise<void> {
    await mountLocalSyncBucket(
      {
        registry: this.registry,
        logger: this.deps.logger,
        getMounts: () => this.client.mounts,
        getOutboundHost: () => this.deps.getOutboundHost(),
        getS3FSHost: () => this.getS3FSHost(),
        getEnv: () => this.deps.getEnv(),
        getClient: () => this.client,
        lifecycle: this.lifecycle
      },
      bucket,
      mountPath,
      options
    );
  }

  private getS3FSHost(): S3FSHost {
    return {
      client: this.client,
      logger: this.deps.logger
    };
  }

  private async mountBucketR2Egress(
    bucket: string,
    mountPath: string,
    options: R2BindingMountBucketOptions
  ): Promise<void> {
    await mountR2EgressBucket(
      {
        registry: this.registry,
        logger: this.deps.logger,
        getMounts: () => this.client.mounts,
        getOutboundHost: () => this.deps.getOutboundHost(),
        getS3FSHost: () => this.getS3FSHost(),
        lifecycle: this.lifecycle
      },
      bucket,
      mountPath,
      options
    );
  }

  private async mountBucketFuse(
    bucket: string,
    mountPath: string,
    options: RemoteMountBucketOptions
  ): Promise<void> {
    await mountRemoteFuseBucket(
      {
        registry: this.registry,
        logger: this.deps.logger,
        getMounts: () => this.client.mounts,
        getOutboundHost: () => this.deps.getOutboundHost(),
        getS3FSHost: () => this.getS3FSHost(),
        getEnv: () => this.deps.getEnv(),
        getEnvVars: () => this.deps.getEnvVars(),
        getR2AccessKeyID: () => this.deps.getR2AccessKeyID(),
        getR2SecretAccessKey: () => this.deps.getR2SecretAccessKey(),
        lifecycle: this.lifecycle
      },
      bucket,
      mountPath,
      options
    );
  }

  /**
   * Manually unmount a bucket filesystem
   *
   * @param mountPath - Absolute path where the bucket is mounted
   * @throws InvalidMountConfigError if mount path doesn't exist or isn't mounted
   */
  async unmountBucket(mountPath: string): Promise<void> {
    return this.operations.run(async () => {
      await this.unmountBucketUnlocked(mountPath);
    });
  }

  private async unmountBucketUnlocked(mountPath: string): Promise<void> {
    await unmountBucketOperation(
      {
        registry: this.registry,
        logger: this.deps.logger,
        getMounts: () => this.client.mounts,
        getOutboundHost: () => this.deps.getOutboundHost(),
        getS3FSHost: () => this.getS3FSHost()
      },
      mountPath
    );
  }

  async cleanupForDestroy(): Promise<BucketMountDestroyCleanupResult> {
    return cleanupBucketMountsForDestroy({
      registry: this.registry,
      logger: this.deps.logger,
      getS3FSHost: () => this.getS3FSHost(),
      getOutboundHost: () => this.deps.getOutboundHost(),
      runMountOperation: (operation) => this.operations.run(operation)
    });
  }

  async cleanupForStop(): Promise<void> {
    return cleanupBucketMountsForStop({
      registry: this.registry,
      logger: this.deps.logger,
      getS3FSHost: () => this.getS3FSHost(),
      getOutboundHost: () => this.deps.getOutboundHost(),
      runMountOperation: (operation) => this.operations.run(operation)
    });
  }
}
