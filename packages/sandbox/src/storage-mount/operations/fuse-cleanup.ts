import type { BucketMountOperationContext } from './context';

export async function unmountFuseIfMountedForCleanup(
  context: BucketMountOperationContext,
  mountPath: string
): Promise<boolean> {
  const isMountpoint = await context.runRuntimeCall(
    'mount.cleanup.isMountpoint',
    (control) => control.mounts.isMountpoint(mountPath)
  );
  if (!isMountpoint) return true;

  const result = await context.runRuntimeCall(
    'mount.cleanup.unmountFuse',
    (control) => control.mounts.unmountFuse(mountPath)
  );
  if (result.success) return true;

  context.logger.warn('FUSE mount cleanup unmount failed', {
    mountPath,
    exitCode: result.exitCode,
    stderr: result.stderr
  });
  return false;
}
