import type { Logger } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import { ErrorCode, Operation } from '@repo/shared/errors';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import type { SessionManager } from './session-manager';

export const BACKUP_WORK_DIR = '/var/backups';
const BACKUP_MOUNTS_DIR = '/var/backups/mounts';

/**
 * Absolute paths for squashfs/FUSE binaries.
 * The Bun standalone binary inherits its PATH from the container runtime,
 * which may not include /usr/bin in all environments (e.g. Cloudflare Containers).
 * Using absolute paths avoids "command not found" failures.
 */
const BIN = {
  mksquashfs: '/usr/bin/mksquashfs',
  squashfuse: '/usr/bin/squashfuse',
  fuseOverlayfs: '/usr/bin/fuse-overlayfs',
  fusermount: '/usr/bin/fusermount3'
} as const;

/**
 * Prefixes of directories that are safe for backup/restore operations.
 * Using an allowlist is more secure than a blocklist - unknown paths are rejected.
 */
const ALLOWED_PREFIXES = ['/workspace', '/home', '/tmp', '/var/tmp'];

/**
 * Directories that must never be backed up or restored into, even if under allowed prefixes.
 */
const FORBIDDEN_DIRS = new Set(['/']);

/**
 * Validate that dir and archivePath are safe for backup operations.
 * Defense-in-depth: the DO already validates, but the container
 * re-checks to guard against programming errors or future callers.
 *
 * Uses allowlist approach: only paths under /workspace, /home, /tmp, /var/tmp are permitted.
 */
function validateBackupPaths(dir: string, archivePath: string): string | null {
  if (!dir.startsWith('/') || FORBIDDEN_DIRS.has(dir)) {
    return `Unsafe directory: ${dir}`;
  }
  // Allowlist check: dir must start with one of the allowed prefixes
  const isAllowed = ALLOWED_PREFIXES.some(
    (prefix) => dir === prefix || dir.startsWith(`${prefix}/`)
  );
  if (!isAllowed) {
    return `Directory not in allowed paths (${ALLOWED_PREFIXES.join(', ')}): ${dir}`;
  }
  if (!archivePath.startsWith(`${BACKUP_WORK_DIR}/`)) {
    return 'Invalid archivePath: must use designated backup directory';
  }
  if (archivePath.includes('..')) {
    return 'Invalid archivePath: must not contain path traversal sequences';
  }
  return null;
}

interface CreateArchiveResult {
  sizeBytes: number;
  archivePath: string;
}

interface RestoreArchiveResult {
  dir: string;
}

/**
 * Creates and restores squashfs-based directory archives.
 *
 * Create flow:
 *   mksquashfs <sourceDir> <archivePath> -comp zstd -no-progress
 *   The archive is a self-contained squashfs image compressed with zstd.
 *
 * Restore flow:
 *   squashfuse <archivePath> <lowerDir>
 *   fuse-overlayfs -o lowerdir=<lowerDir>,upperdir=<upperDir>,workdir=<workDir> <targetDir>
 *   Mounts the squashfs image as a read-only layer with a writable overlay on top.
 *
 * The DO (Sandbox class) handles R2 upload/download. This service only deals
 * with local filesystem operations.
 */
export class BackupService {
  constructor(
    private logger: Logger,
    private sessionManager: SessionManager
  ) {}

  /**
   * Create a squashfs archive from a directory.
   * The archive is written to archivePath.
   */
  async createArchive(
    dir: string,
    archivePath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<CreateArchiveResult>> {
    const opLogger = this.logger.child({ operation: Operation.BACKUP_CREATE });

    const pathError = validateBackupPaths(dir, archivePath);
    if (pathError) {
      return serviceError({
        message: pathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { dir, archivePath }
      });
    }

    try {
      // Ensure the work directory exists
      const mkdirResult = await this.sessionManager.executeInSession(
        sessionId,
        `mkdir -p ${shellEscape(BACKUP_WORK_DIR)}`
      );
      if (!mkdirResult.success) {
        return serviceError({
          message: `Failed to create backup work directory: ${mkdirResult.error.message}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir, archivePath }
        });
      }

      // Verify the source directory exists
      const checkResult = await this.sessionManager.executeInSession(
        sessionId,
        `test -d ${shellEscape(dir)}`
      );
      if (!checkResult.success || checkResult.data.exitCode !== 0) {
        return serviceError({
          message: `Source directory does not exist: ${dir}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir }
        });
      }

      // Pre-flight check: verify mksquashfs binary exists
      // This provides a clearer error than "command not found" from bash
      const checkBinaryResult = await this.sessionManager.executeInSession(
        sessionId,
        `test -x ${BIN.mksquashfs} && echo exists || echo "missing: ${BIN.mksquashfs}"`
      );
      if (
        checkBinaryResult.success &&
        checkBinaryResult.data.stdout.includes('missing')
      ) {
        return serviceError({
          message: `mksquashfs binary not found at ${BIN.mksquashfs}. Ensure squashfs-tools is installed.`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir, archivePath, binaryPath: BIN.mksquashfs }
        });
      }

      // Create squashfs archive with zstd compression
      // -no-progress suppresses progress output
      // -noappend creates a fresh archive (no appending to existing)
      const squashCmd = [
        BIN.mksquashfs,
        shellEscape(dir),
        shellEscape(archivePath),
        '-comp zstd',
        '-no-progress',
        '-noappend'
      ].join(' ');

      opLogger.info('Creating squashfs archive', {
        dir,
        archivePath,
        command: squashCmd
      });

      const createResult = await this.sessionManager.executeInSession(
        sessionId,
        squashCmd
      );

      if (!createResult.success) {
        return serviceError({
          message: `Failed to create squashfs archive: ${createResult.error.message}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir, archivePath }
        });
      }

      if (createResult.data.exitCode !== 0) {
        return serviceError({
          message: `mksquashfs failed: ${createResult.data.stderr || createResult.data.stdout}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: {
            dir,
            archivePath,
            exitCode: createResult.data.exitCode,
            stderr: createResult.data.stderr
          }
        });
      }

      // Get the archive size
      // `stat -c` is GNU/Linux-specific (the container is always Linux)
      const statResult = await this.sessionManager.executeInSession(
        sessionId,
        `stat -c %s ${shellEscape(archivePath)}`
      );

      let sizeBytes = 0;
      if (statResult.success && statResult.data.exitCode === 0) {
        sizeBytes = parseInt(statResult.data.stdout.trim(), 10) || 0;
      }

      opLogger.info('Archive created', { dir, archivePath, sizeBytes });

      return serviceSuccess<CreateArchiveResult>({
        sizeBytes,
        archivePath
      });
    } catch (error) {
      opLogger.error(
        'Unexpected error creating archive',
        error instanceof Error ? error : new Error(String(error))
      );
      return serviceError({
        message: `Unexpected error creating backup: ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        details: { dir, archivePath }
      });
    }
  }

  /**
   * Restore a squashfs archive into a directory using overlayfs.
   *
   * This mounts the squashfs as a read-only lower layer and uses
   * fuse-overlayfs to provide a writable upper layer, giving instant
   * restore with copy-on-write semantics.
   *
   * Mount structure:
   *   /var/backups/mounts/{backupId}/lower  - squashfs mount (read-only)
   *   /var/backups/mounts/{backupId}/upper  - writable changes
   *   /var/backups/mounts/{backupId}/work   - overlayfs workdir
   *   {dir}                                  - merged overlay view
   */
  async restoreArchive(
    dir: string,
    archivePath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<RestoreArchiveResult>> {
    const opLogger = this.logger.child({
      operation: Operation.BACKUP_RESTORE
    });

    const pathError = validateBackupPaths(dir, archivePath);
    if (pathError) {
      return serviceError({
        message: pathError,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { dir, archivePath }
      });
    }

    // Extract backup ID from archive path (e.g., /var/backups/abc123.sqsh -> abc123)
    const backupId = archivePath
      .replace(`${BACKUP_WORK_DIR}/`, '')
      .replace('.sqsh', '');
    const mountBase = `${BACKUP_MOUNTS_DIR}/${backupId}`;
    const lowerDir = `${mountBase}/lower`;
    const upperDir = `${mountBase}/upper`;
    const workDir = `${mountBase}/work`;

    try {
      // Verify the archive exists
      const checkResult = await this.sessionManager.executeInSession(
        sessionId,
        `test -f ${shellEscape(archivePath)}`
      );
      if (!checkResult.success || checkResult.data.exitCode !== 0) {
        return serviceError({
          message: `Archive file does not exist: ${archivePath}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }

      opLogger.info('Restoring snapshot with overlayfs', {
        dir,
        archivePath,
        backupId
      });

      // Clean up any existing mounts from previous restores of this backup.
      // Unmount overlayfs first (depends on squashfuse), then squashfuse.
      // Uses non-lazy unmount first, falling back to lazy (-uz) so stale
      // FUSE mounts are detached even if still referenced.
      await this.sessionManager.executeInSession(
        sessionId,
        `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null; ${BIN.fusermount} -uz ${shellEscape(dir)} 2>/dev/null; true`
      );
      await this.sessionManager.executeInSession(
        sessionId,
        `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null; ${BIN.fusermount} -uz ${shellEscape(lowerDir)} 2>/dev/null; true`
      );

      // Remove and recreate mount directories to ensure a clean upper layer.
      // Removing upperDir is critical: leftover writes from a previous overlay
      // would reappear when the new overlayfs is mounted on the same upper.
      const cleanupResult = await this.sessionManager.executeInSession(
        sessionId,
        [
          `rm -rf ${shellEscape(upperDir)} ${shellEscape(workDir)}`,
          `rm -rf ${shellEscape(lowerDir)} 2>/dev/null`,
          `rm -rf ${shellEscape(mountBase)} 2>/dev/null`,
          `mkdir -p ${shellEscape(lowerDir)} ${shellEscape(upperDir)} ${shellEscape(workDir)} ${shellEscape(dir)}`
        ].join('; ')
      );
      if (!cleanupResult.success) {
        return serviceError({
          message: `Failed to prepare mount directories: ${cleanupResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }
      if (cleanupResult.data.exitCode !== 0) {
        return serviceError({
          message: `Failed to prepare mount directories: ${cleanupResult.data.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }

      // Ensure target directory exists (may have been created above, but be explicit)
      const mkdirResult = await this.sessionManager.executeInSession(
        sessionId,
        `mkdir -p ${shellEscape(dir)}`
      );
      if (!mkdirResult.success) {
        return serviceError({
          message: `Failed to create mount directories: ${mkdirResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }
      if (mkdirResult.data.exitCode !== 0) {
        return serviceError({
          message: `Failed to create mount directories: ${mkdirResult.data.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath }
        });
      }

      // Mount squashfs as the lower (read-only) layer
      const squashMountCmd = `${BIN.squashfuse} ${shellEscape(archivePath)} ${shellEscape(lowerDir)}`;
      const squashMountResult = await this.sessionManager.executeInSession(
        sessionId,
        squashMountCmd
      );
      if (!squashMountResult.success) {
        return serviceError({
          message: `Failed to mount squashfs: ${squashMountResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: squashMountCmd }
        });
      }
      if (squashMountResult.data.exitCode !== 0) {
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

      const overlayMountResult = await this.sessionManager.executeInSession(
        sessionId,
        overlayMountCmd
      );
      if (!overlayMountResult.success) {
        // Cleanup: unmount squashfs on failure
        await this.sessionManager.executeInSession(
          sessionId,
          `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || true`
        );
        return serviceError({
          message: `Failed to mount overlayfs: ${overlayMountResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: overlayMountCmd }
        });
      }
      if (overlayMountResult.data.exitCode !== 0) {
        // Cleanup: unmount squashfs on failure
        await this.sessionManager.executeInSession(
          sessionId,
          `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || true`
        );
        return serviceError({
          message: `Failed to mount overlayfs: ${overlayMountResult.data.stderr}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: overlayMountCmd }
        });
      }

      opLogger.info('Snapshot restored with overlayfs', {
        dir,
        archivePath,
        backupId
      });

      return serviceSuccess<RestoreArchiveResult>({ dir });
    } catch (error) {
      opLogger.error(
        'Unexpected error restoring archive',
        error instanceof Error ? error : new Error(String(error))
      );
      // Best-effort cleanup of any FUSE mounts that may have been established
      await this.sessionManager
        .executeInSession(
          sessionId,
          `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null || true`
        )
        .catch(() => {});
      await this.sessionManager
        .executeInSession(
          sessionId,
          `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || true`
        )
        .catch(() => {});
      return serviceError({
        message: `Unexpected error restoring backup: ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { dir, archivePath }
      });
    }
  }

  /**
   * Unmount a previously restored snapshot.
   * This cleans up the overlayfs and squashfs mounts.
   * Currently internal-only; no HTTP route exposes this method.
   * Reserved for future use when unmount API is added.
   */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved for future unmount API
  private async unmountSnapshot(
    dir: string,
    backupId: string,
    sessionId = 'default'
  ): Promise<ServiceResult<{ success: boolean }>> {
    const opLogger = this.logger.child({
      operation: Operation.BACKUP_UNMOUNT
    });

    // Validate inputs before constructing paths used in rm -rf
    if (
      !dir ||
      !dir.startsWith('/') ||
      dir.includes('..') ||
      dir.includes('\0')
    ) {
      return serviceError({
        message: `Unsafe directory for unmount: ${dir}`,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { dir, backupId }
      });
    }
    if (
      !backupId ||
      backupId.includes('/') ||
      backupId.includes('..') ||
      backupId.includes('\0')
    ) {
      return serviceError({
        message: `Invalid backupId for unmount: ${backupId}`,
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        details: { dir, backupId }
      });
    }

    const mountBase = `${BACKUP_MOUNTS_DIR}/${backupId}`;
    const lowerDir = `${mountBase}/lower`;

    try {
      opLogger.info('Unmounting snapshot', { dir, backupId });

      // Unmount overlayfs first
      await this.sessionManager.executeInSession(
        sessionId,
        `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null || umount ${shellEscape(dir)} 2>/dev/null || true`
      );

      // Unmount squashfs
      await this.sessionManager.executeInSession(
        sessionId,
        `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || umount ${shellEscape(lowerDir)} 2>/dev/null || true`
      );

      // Verify mounts are gone before removing directories
      const mountCheck = await this.sessionManager.executeInSession(
        sessionId,
        `mountpoint -q ${shellEscape(dir)} 2>/dev/null && echo "mounted" || echo "unmounted"`
      );
      if (mountCheck.success && mountCheck.data.stdout.trim() === 'mounted') {
        opLogger.warn('Overlay mount still active after unmount attempt', {
          dir,
          backupId
        });
        return serviceError({
          message: `Failed to unmount overlay at ${dir}. Mount is still active.`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, backupId }
        });
      }

      // Clean up mount directories (but keep the archive)
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -rf ${shellEscape(mountBase)}`
      );

      opLogger.info('Snapshot unmounted', { dir, backupId });

      return serviceSuccess({ success: true });
    } catch (error) {
      opLogger.error(
        'Error unmounting snapshot',
        error instanceof Error ? error : new Error(String(error))
      );
      return serviceError({
        message: `Failed to unmount snapshot: ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { dir, backupId }
      });
    }
  }
}
