import type { BucketMountOperationContext } from './context';

export async function unmountFuseIfMountedForCleanup(
  context: BucketMountOperationContext,
  mountPath: string
): Promise<boolean> {
  const mounts = context.getMounts();
  if (!(await mounts.isMountpoint(mountPath))) return true;

  const result = await mounts.unmountFuse(mountPath);
  if (result.success) return true;

  context.logger.warn('FUSE mount cleanup unmount failed', {
    mountPath,
    exitCode: result.exitCode,
    stderr: result.stderr
  });
  return false;
}
