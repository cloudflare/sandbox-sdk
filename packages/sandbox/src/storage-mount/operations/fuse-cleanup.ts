import { shellEscape } from '@repo/shared';
import type { BucketMountOperationContext } from './context';

export async function unmountFuseIfMountedForCleanup(
  context: BucketMountOperationContext,
  mountPath: string
): Promise<boolean> {
  const result = await context.execInternal(
    `if mountpoint -q ${shellEscape(mountPath)}; then fusermount -u ${shellEscape(mountPath)}; else exit 0; fi`
  );
  if (result.exitCode === 0) return true;

  context.logger.warn('FUSE mount cleanup unmount failed', {
    mountPath,
    exitCode: result.exitCode,
    stderr: result.stderr
  });
  return false;
}
