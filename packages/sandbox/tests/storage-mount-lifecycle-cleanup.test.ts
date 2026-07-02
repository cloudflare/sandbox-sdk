import type { ExecResult, Logger } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerControlClient } from '../src/container-control';
import { cleanupBucketMountsForDestroy } from '../src/storage-mount/lifecycle-cleanup';
import type { MountOutboundHost } from '../src/storage-mount/outbound';
import { MountRegistry } from '../src/storage-mount/registry';
import type { S3FSHost } from '../src/storage-mount/s3fs';
import type { R2BindingMountInfo } from '../src/storage-mount/types';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger())
  } as unknown as Logger;
}

function execResult(overrides?: Partial<ExecResult>): ExecResult {
  return {
    success:
      overrides?.exitCode === undefined ? true : overrides.exitCode === 0,
    exitCode: 0,
    stdout: '',
    stderr: '',
    command: '',
    duration: 0,
    timestamp: '2026-07-02T00:00:00.000Z',
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
  it('preserves failed FUSE unmounts for a later destroy cleanup retry', async () => {
    const logger = createLogger();
    const execInternal = vi
      .fn<(command: string) => Promise<ExecResult>>()
      .mockResolvedValueOnce(execResult({ exitCode: 1, stderr: 'busy' }))
      .mockResolvedValueOnce(execResult())
      .mockResolvedValue(execResult());
    const s3fsHost: S3FSHost = {
      client: {} as unknown as ContainerControlClient,
      logger,
      execInternal
    };
    const outboundHost = createOutboundHost(logger);
    const registry = new MountRegistry();
    registry.set('/mnt/r2', createR2Mount('/mnt/r2'));
    const runMountOperation = <T>(operation: () => Promise<T>) => operation();

    const firstResult = await cleanupBucketMountsForDestroy({
      registry,
      logger,
      getS3FSHost: () => s3fsHost,
      getOutboundHost: () => outboundHost,
      runMountOperation
    });

    expect(firstResult).toEqual({ mountsProcessed: 1, mountFailures: 1 });
    expect(registry.has('/mnt/r2')).toBe(true);
    expect(registry.get('/mnt/r2')?.mounted).toBe(true);
    expect(
      execInternal.mock.calls.some(([command]) =>
        command.includes('fusermount -u')
      )
    ).toBe(true);

    const retryResult = await cleanupBucketMountsForDestroy({
      registry,
      logger,
      getS3FSHost: () => s3fsHost,
      getOutboundHost: () => outboundHost,
      runMountOperation
    });

    expect(retryResult).toEqual({ mountsProcessed: 1, mountFailures: 0 });
    expect(registry.activeMounts.size).toBe(0);
    expect(
      execInternal.mock.calls.some(
        ([command]) =>
          command.startsWith('rm -f ') && command.includes('passwd')
      )
    ).toBe(true);
    expect(
      execInternal.mock.calls.some(
        ([command]) => command.startsWith('rm -f ') && command.includes('ahbe')
      )
    ).toBe(true);
    expect(outboundHost.removeOutboundByHost).toHaveBeenCalledWith(
      'r2.internal'
    );
  });
});
