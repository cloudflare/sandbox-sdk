import type { Logger, MountCommandResult } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerControlClient } from '../src/container-control';
import { cleanupBucketMountsForDestroy } from '../src/storage-mount/lifecycle-cleanup';
import type { MountOutboundHost } from '../src/storage-mount/outbound';
import { MountRegistry } from '../src/storage-mount/registry';
import type { S3FSHost } from '../src/storage-mount/s3fs';
import type {
  LocalSyncMountInfo,
  R2BindingMountInfo
} from '../src/storage-mount/types';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger())
  } as unknown as Logger;
}

function mountResult(
  overrides?: Partial<MountCommandResult>
): MountCommandResult {
  return {
    success: overrides?.exitCode === undefined || overrides.exitCode === 0,
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides
  };
}

function createOutboundHost(logger: Logger): MountOutboundHost {
  return {
    ctx: {
      id: { toString: () => 'test-container' },
      exports: {
        ContainerProxy: () => ({
          fetch: vi.fn(async () => new Response('ok'))
        })
      },
      container: {
        interceptOutboundHttp: vi.fn(async () => undefined)
      }
    } as unknown as MountOutboundHost['ctx'],
    constructorRef: function TestContainer() {},
    logger,
    setOutboundByHost: vi.fn(async () => undefined),
    removeOutboundByHost: vi.fn(async () => undefined)
  };
}

function createR2Mount(mountPath: string): R2BindingMountInfo {
  return {
    mountId: `mount-${mountPath}`,
    mountType: 'r2-egress',
    bucket: 'MY_BUCKET',
    mountPath,
    passwordFilePath: `/tmp/passwd-${mountPath.replaceAll('/', '-')}`,
    additionalHeaderFilePath: `/tmp/ahbe-${mountPath.replaceAll('/', '-')}`,
    mounted: true,
    readOnly: false
  };
}

describe('bucket mount destroy lifecycle cleanup', () => {
  it('interrupts local sync without waiting for a hung stop', async () => {
    const logger = createLogger();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const interrupt = vi.fn();
    const registry = new MountRegistry();
    registry.set('/mnt/local', {
      mountId: 'mount-local',
      mountType: 'local-sync',
      bucket: 'MY_BUCKET',
      mountPath: '/mnt/local',
      mounted: true,
      syncManager: { stop, interrupt }
    } as unknown as LocalSyncMountInfo);

    const result = await cleanupBucketMountsForDestroy({
      registry,
      logger,
      s3fsHost: null,
      getOutboundHost: () => createOutboundHost(logger),
      runMountOperation: (operation) => operation()
    });

    expect(result).toEqual({ mountsProcessed: 1, mountFailures: 0 });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(registry.activeMounts.size).toBe(0);
  });

  it('clears logical destroy state even when physical FUSE unmount fails', async () => {
    const logger = createLogger();
    const unmountFuse = vi
      .fn<(path: string) => Promise<MountCommandResult>>()
      .mockResolvedValueOnce(mountResult({ exitCode: 1, stderr: 'busy' }))
      .mockResolvedValueOnce(mountResult())
      .mockResolvedValue(mountResult());
    const deleteFile = vi.fn(async () => undefined);
    const s3fsHost: S3FSHost = {
      runRuntimeCall: async (_operation, call) =>
        call({
          mounts: { unmountFuse, deleteFile }
        } as unknown as ContainerControlClient),
      logger
    };
    const outboundHost = createOutboundHost(logger);
    const registry = new MountRegistry();
    registry.set('/mnt/r2', createR2Mount('/mnt/r2'));
    const runMountOperation = <T>(operation: () => Promise<T>) => operation();

    const firstResult = await cleanupBucketMountsForDestroy({
      registry,
      logger,
      s3fsHost,
      getOutboundHost: () => outboundHost,
      runMountOperation
    });

    expect(firstResult).toEqual({ mountsProcessed: 1, mountFailures: 1 });
    expect(registry.activeMounts.size).toBe(0);
    expect(unmountFuse).toHaveBeenCalledWith('/mnt/r2');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(outboundHost.removeOutboundByHost).toHaveBeenCalledWith(
      'r2.internal'
    );
  });
});
