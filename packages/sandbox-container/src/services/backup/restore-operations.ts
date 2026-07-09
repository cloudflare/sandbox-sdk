import type { Logger } from '@repo/shared';
import { logCanonicalEvent, shellEscape } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import {
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../../core/types';
import type { CommandContextService } from '../command-context-service';
import type { InternalCommandResult } from '../internal-command-result';
import {
  BACKUP_MOUNTS_DIR,
  BACKUP_WORK_DIR,
  BIN,
  type RestoreArchiveResult,
  validateArchivePath,
  validateBackupId,
  validateBackupPaths
} from './archive-operations';

export class RestoreOperations {
  constructor(
    private logger: Logger,
    private commandContextService: CommandContextService
  ) {}

  private async executeInternal(
    command: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ServiceResult<InternalCommandResult>> {
    try {
      const result = await this.commandContextService.run(command, {
        timeoutMs: options.timeoutMs
      });
      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        error: this.toServiceError(error)
      };
    }
  }

  private toServiceError(error: unknown): ServiceError {
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      code: ErrorCode.INTERNAL_ERROR
    };
  }

  async prepareRestore(request: {
    dir: string;
    backupId: string;
    archivePath: string;
  }): Promise<ServiceResult<{ existingSize: number }>> {
    const pathError = validateBackupPaths(request.dir, request.archivePath);
    if (pathError) {
      return serviceError({
        message: pathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { dir: request.dir, archivePath: request.archivePath }
      });
    }
    const backupIdError = validateBackupId(request.backupId);
    if (backupIdError) {
      return serviceError({
        message: backupIdError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { backupId: request.backupId }
      });
    }
    const mountGlob = `${BACKUP_MOUNTS_DIR}/${request.backupId}`;
    await this.executeInternal(
      `${BIN.fusermount} -u ${shellEscape(request.dir)} 2>/dev/null || umount ${shellEscape(request.dir)} 2>/dev/null || true`
    ).catch(() => undefined);
    await this.executeInternal(
      `for d in ${shellEscape(mountGlob)}_*/lower ${shellEscape(mountGlob)}/lower; do [ -d "$d" ] && ${BIN.fusermount} -u "$d" 2>/dev/null; done; rm -rf ${shellEscape(mountGlob)}_* ${shellEscape(mountGlob)} 2>/dev/null; true`
    ).catch(() => undefined);
    const result = await this.executeInternal(
      `mkdir -p ${shellEscape(BACKUP_WORK_DIR)} && if test -f ${shellEscape(request.archivePath)}; then stat -c %s ${shellEscape(request.archivePath)}; else echo 0; fi`
    );
    if (!result.success || result.data.exitCode !== 0) {
      return serviceError({
        message: `Failed to prepare restore: ${result.success ? result.data.stderr : result.error.message}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { dir: request.dir, archivePath: request.archivePath }
      });
    }
    return serviceSuccess({
      existingSize: Number(result.data.stdout.trim()) || 0
    });
  }

  async extractArchive(
    dir: string,
    archivePath: string
  ): Promise<ServiceResult<void>> {
    const pathError = validateBackupPaths(dir, archivePath);
    if (pathError) {
      return serviceError({
        message: pathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { dir, archivePath }
      });
    }
    const result = await this.executeInternal(
      `${BIN.unsquashfs} -f -d ${shellEscape(dir)} ${shellEscape(archivePath)}`
    );
    if (!result.success || result.data.exitCode !== 0) {
      return serviceError({
        message: `Failed to extract backup archive: ${result.success ? result.data.stderr || result.data.stdout : result.error.message}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { dir, archivePath }
      });
    }
    return serviceSuccess(undefined);
  }

  async restoreArchive(
    dir: string,
    archivePath: string
  ): Promise<ServiceResult<RestoreArchiveResult>> {
    // Extract backup ID from archive path (e.g., /var/backups/abc123.sqsh -> abc123)
    const backupId = archivePath
      .replace(`${BACKUP_WORK_DIR}/`, '')
      .replace('.sqsh', '');

    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;

    try {
      const pathError = validateBackupPaths(dir, archivePath);
      if (pathError) {
        errorMessage = pathError;
        return serviceError({
          message: pathError,
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          details: { dir, archivePath }
        });
      }
      const backupIdError = validateBackupId(backupId);
      if (backupIdError) {
        errorMessage = backupIdError;
        return serviceError({
          message: backupIdError,
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          details: { archivePath }
        });
      }
      // Each restore uses a unique mount base so stale upper-layer files from a
      // previous overlay mount cannot leak into a new mount.  Old mount bases
      // for this backup ID are torn down (best-effort) before the new mount.
      const restoreId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const mountBase = `${BACKUP_MOUNTS_DIR}/${backupId}_${restoreId}`;
      const lowerDir = `${mountBase}/lower`;
      const upperDir = `${mountBase}/upper`;
      const workDir = `${mountBase}/work`;
      const cleanupMountBase = async () => {
        await this.executeInternal(
          `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null || true; ${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || true; rm -rf ${shellEscape(mountBase)} 2>/dev/null; true`
        );
      };
      // Verify the archive exists
      const checkResult = await this.executeInternal(
        `test -f ${shellEscape(archivePath)}`
      );
      if (!checkResult.success || checkResult.data.exitCode !== 0) {
        errorMessage = 'Archive file does not exist';
        return serviceError({
          message: `Archive file does not exist: ${archivePath}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }

      // Unmount the overlay on `dir` (from a previous restore of any backup).
      await this.executeInternal(
        `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null; ${BIN.fusermount} -uz ${shellEscape(dir)} 2>/dev/null; true`
      );

      // Tear down all previous mount bases for this backup ID.
      // Each old mount base may have squashfuse on its lower dir; unmount
      // those before removing the directories.  The glob covers both the
      // new suffixed layout (UUID_*) and the legacy unsuffixed layout (UUID/).
      const mountGlob = `${BACKUP_MOUNTS_DIR}/${backupId}`;
      await this.executeInternal(
        `for d in ${shellEscape(mountGlob)}_*/lower ${shellEscape(mountGlob)}/lower; do [ -d "$d" ] && ${BIN.fusermount} -u "$d" 2>/dev/null; ${BIN.fusermount} -uz "$d" 2>/dev/null; done; true`
      );

      // Remove old mount bases (best-effort)
      await this.executeInternal(
        `rm -rf ${shellEscape(mountGlob)}_* ${shellEscape(mountGlob)} 2>/dev/null; true`
      );

      // Create fresh mount directories
      const mkdirResult = await this.executeInternal(
        `mkdir -p ${shellEscape(lowerDir)} ${shellEscape(upperDir)} ${shellEscape(workDir)} ${shellEscape(dir)}`
      );
      if (!mkdirResult.success) {
        errorMessage = 'Failed to create mount directories';
        return serviceError({
          message: `Failed to create mount directories: ${mkdirResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }
      if (mkdirResult.data.exitCode !== 0) {
        errorMessage = 'Failed to create mount directories';
        return serviceError({
          message: `Failed to create mount directories: ${mkdirResult.data.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }

      // Mount squashfs as the lower (read-only) layer
      const squashMountCmd = `${BIN.squashfuse} ${shellEscape(archivePath)} ${shellEscape(lowerDir)}`;
      const squashMountResult = await this.executeInternal(squashMountCmd);
      if (!squashMountResult.success) {
        await cleanupMountBase();
        errorMessage = 'Failed to mount squashfs';
        return serviceError({
          message: `Failed to mount squashfs: ${squashMountResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: squashMountCmd }
        });
      }
      if (squashMountResult.data.exitCode !== 0) {
        await cleanupMountBase();
        errorMessage = 'Failed to mount squashfs';
        return serviceError({
          message: `Failed to mount squashfs: ${squashMountResult.data.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: squashMountCmd }
        });
      }

      // Mount overlayfs to combine lower (snapshot) + upper (writable) layers
      // Using fuse-overlayfs for userspace overlay support in containers
      // All mount options in a single -o flag as comma-separated values
      const overlayMountCmd = [
        BIN.fuseOverlayfs,
        `-o lowerdir=${shellEscape(lowerDir)},upperdir=${shellEscape(upperDir)},workdir=${shellEscape(workDir)}`,
        shellEscape(dir)
      ].join(' ');

      const overlayMountResult = await this.executeInternal(overlayMountCmd);
      if (!overlayMountResult.success) {
        await cleanupMountBase();
        errorMessage = 'Failed to mount overlayfs';
        return serviceError({
          message: `Failed to mount overlayfs: ${overlayMountResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: overlayMountCmd }
        });
      }
      if (overlayMountResult.data.exitCode !== 0) {
        await cleanupMountBase();
        errorMessage = 'Failed to mount overlayfs';
        return serviceError({
          message: `Failed to mount overlayfs: ${overlayMountResult.data.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: overlayMountCmd }
        });
      }

      outcome = 'success';

      return serviceSuccess<RestoreArchiveResult>({ dir });
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;
      // Best-effort cleanup of any FUSE mounts that may have been established.
      // Clean up the overlay on dir; per-restore lowerDir is scoped inside try
      // and cleaned up by the mount-base glob teardown on the next restore.
      await this.executeInternal(
        `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null || true`
      ).catch(() => {});
      return serviceError({
        message: `Unexpected error restoring backup: ${caughtError.message}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { dir, archivePath }
      });
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'backup.restore',
        outcome,
        durationMs: Date.now() - startTime,
        dir,
        archivePath,
        backupId,
        errorMessage,
        error: caughtError
      });
    }
  }
}
