import type {
  LocalMountBucketOptions,
  Logger,
  MountBucketOptions,
  R2BindingMountBucketOptions,
  RemoteMountBucketOptions
} from '@repo/shared';
import { OperationInterruptedError } from '../errors';
import type { RuntimeIdentityReader } from '../runtime';
import type { CurrentSandboxLifetime } from '../sandbox-lifetime';
import { InvalidMountConfigError } from './errors';
import { MountLifecycle } from './lifecycle';
import {
  type BucketMountDestroyCleanupResult,
  cleanupBucketMountsForDestroy,
  cleanupBucketMountsForStop
} from './lifecycle-cleanup';
import { MountOperationQueue } from './operation-queue';
import {
  mountLocalSyncBucket,
  validateLocalSyncMount
} from './operations/local-sync-mount';
import {
  mountR2EgressBucket,
  validateR2EgressMount
} from './operations/r2-egress-mount';
import {
  mountRemoteFuseBucket,
  validateRemoteFuseMount
} from './operations/remote-fuse-mount';
import { unmountBucketOperation } from './operations/unmount';
import type { MountOutboundHost } from './outbound';
import { MountRegistry } from './registry';
import {
  callWithMountControl,
  type MountExistingRuntimeAttempt,
  type MountRuntimeAttempt,
  type MountRuntimeCall
} from './runtime-call';
import { isR2Bucket, validateBucketName, validatePrefix } from './validation';

export interface BucketMountServiceDeps {
  getEnv(): unknown;
  getEnvVars(): Record<string, string>;
  runMountAttempt: MountRuntimeAttempt;
  runExistingMountAttempt: MountExistingRuntimeAttempt;
  logger: Logger;
  runtimeReader: RuntimeIdentityReader;
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
      deps.runtimeReader,
      deps.currentLifetime
    );
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
    validateLocalSyncMount(
      {
        registry: this.registry,
        getEnv: () => this.deps.getEnv()
      },
      bucket,
      mountPath
    );
    await this.deps.runMountAttempt('mount.local', async (lease) => {
      const runRuntimeCall = callWithMountControl(lease.control);
      await mountLocalSyncBucket(
        {
          registry: this.registry,
          logger: this.deps.logger,
          runRuntimeCall,
          getOutboundHost: () => this.deps.getOutboundHost(),
          s3fsHost: { runRuntimeCall, logger: this.deps.logger },
          getEnv: () => this.deps.getEnv(),
          lifecycle: this.lifecycle,
          runtime: lease.runtime,
          retainRuntime: lease.retain
        },
        bucket,
        mountPath,
        options
      );
    });
  }

  private async mountBucketR2Egress(
    bucket: string,
    mountPath: string,
    options: R2BindingMountBucketOptions
  ): Promise<void> {
    validateR2EgressMount(
      { registry: this.registry },
      bucket,
      mountPath,
      options
    );
    await this.deps.runMountAttempt('mount.r2-egress', async (lease) => {
      const runRuntimeCall = callWithMountControl(lease.control);
      await mountR2EgressBucket(
        {
          registry: this.registry,
          logger: this.deps.logger,
          runRuntimeCall,
          getOutboundHost: () => this.deps.getOutboundHost(),
          s3fsHost: { runRuntimeCall, logger: this.deps.logger },
          lifecycle: this.lifecycle,
          runtime: lease.runtime
        },
        bucket,
        mountPath,
        options
      );
    });
  }

  private async mountBucketFuse(
    bucket: string,
    mountPath: string,
    options: RemoteMountBucketOptions
  ): Promise<void> {
    validateRemoteFuseMount(
      {
        registry: this.registry,
        logger: this.deps.logger,
        getEnv: () => this.deps.getEnv(),
        getEnvVars: () => this.deps.getEnvVars(),
        getR2AccessKeyID: () => this.deps.getR2AccessKeyID(),
        getR2SecretAccessKey: () => this.deps.getR2SecretAccessKey()
      },
      bucket,
      mountPath,
      options
    );
    await this.deps.runMountAttempt('mount.fuse', async (lease) => {
      const runRuntimeCall = callWithMountControl(lease.control);
      await mountRemoteFuseBucket(
        {
          registry: this.registry,
          logger: this.deps.logger,
          runRuntimeCall,
          getOutboundHost: () => this.deps.getOutboundHost(),
          s3fsHost: { runRuntimeCall, logger: this.deps.logger },
          getEnv: () => this.deps.getEnv(),
          getEnvVars: () => this.deps.getEnvVars(),
          getR2AccessKeyID: () => this.deps.getR2AccessKeyID(),
          getR2SecretAccessKey: () => this.deps.getR2SecretAccessKey(),
          lifecycle: this.lifecycle,
          runtime: lease.runtime
        },
        bucket,
        mountPath,
        options
      );
    });
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
    try {
      const result = await this.deps.runExistingMountAttempt(
        'mount.unmount',
        async (lease) => {
          const runRuntimeCall = callWithMountControl(lease.control);
          await unmountBucketOperation(
            {
              registry: this.registry,
              logger: this.deps.logger,
              runRuntimeCall,
              getOutboundHost: () => this.deps.getOutboundHost(),
              s3fsHost: { runRuntimeCall, logger: this.deps.logger }
            },
            mountPath
          );
        }
      );
      if (result.status === 'completed') return;
    } catch (error) {
      if (!(error instanceof OperationInterruptedError)) throw error;
      if (!this.registry.has(mountPath)) return;
    }
    await this.unmountBucketWithoutRuntime(mountPath);
  }

  private async unmountBucketWithoutRuntime(mountPath: string): Promise<void> {
    await unmountBucketOperation(
      {
        registry: this.registry,
        logger: this.deps.logger,
        runRuntimeCall: async () => {
          throw new Error('runtime is not active');
        },
        getOutboundHost: () => this.deps.getOutboundHost(),
        s3fsHost: null
      },
      mountPath
    );
  }

  async cleanupForDestroy(): Promise<BucketMountDestroyCleanupResult> {
    const result = await this.deps.runExistingMountAttempt(
      'mount.destroyCleanup',
      async (lease) =>
        await this.cleanupForDestroyUsing(callWithMountControl(lease.control))
    );
    if (result.status === 'completed') return result.value;
    return this.cleanupForDestroyWithoutRuntime();
  }

  async cleanupForDestroyUsing(
    runRuntimeCall: MountRuntimeCall
  ): Promise<BucketMountDestroyCleanupResult> {
    return cleanupBucketMountsForDestroy({
      registry: this.registry,
      logger: this.deps.logger,
      s3fsHost: {
        runRuntimeCall,
        logger: this.deps.logger
      },
      getOutboundHost: () => this.deps.getOutboundHost(),
      runMountOperation: (operation) => this.operations.run(operation)
    });
  }

  async cleanupForDestroyWithoutRuntime(): Promise<BucketMountDestroyCleanupResult> {
    return cleanupBucketMountsForDestroy({
      registry: this.registry,
      logger: this.deps.logger,
      s3fsHost: null,
      getOutboundHost: () => this.deps.getOutboundHost(),
      runMountOperation: (operation) => operation()
    });
  }

  async cleanupForStop(): Promise<void> {
    return cleanupBucketMountsForStop({
      registry: this.registry,
      logger: this.deps.logger,
      s3fsHost: null,
      getOutboundHost: () => this.deps.getOutboundHost(),
      runMountOperation: (operation) => this.operations.run(operation)
    });
  }
}
