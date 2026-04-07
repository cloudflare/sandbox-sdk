import type { Logger } from '@repo/shared';
import { logCanonicalEvent, shellEscape } from '@repo/shared';
import { BACKUP_ALLOWED_PREFIXES } from '@repo/shared/backup';
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

function isSafeAbsolutePath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\0')
  );
}

/**
 * Validate that dir and archivePath are safe for backup operations.
 * Defense-in-depth: the DO already validates, but the container
 * re-checks to guard against programming errors or future callers.
 *
 * Uses allowlist approach: only paths under supported backup roots are permitted.
 */
function validateBackupPaths(dir: string, archivePath: string): string | null {
  if (!isSafeAbsolutePath(dir)) {
    return `Backup directory must be a safe absolute path (no '..' or null bytes) under an allowed prefix (${BACKUP_ALLOWED_PREFIXES.join(', ')}): ${dir}`;
  }
  // Allowlist check: dir must start with one of the allowed prefixes
  const isAllowed = BACKUP_ALLOWED_PREFIXES.some(
    (prefix) => dir === prefix || dir.startsWith(`${prefix}/`)
  );
  if (!isAllowed) {
    return `Directory not in allowed paths (${BACKUP_ALLOWED_PREFIXES.join(', ')}): ${dir}`;
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
    sessionId = 'default',
    gitignore = false,
    excludes: string[] = []
  ): Promise<ServiceResult<CreateArchiveResult>> {
    const opLogger = this.logger.child({ operation: Operation.BACKUP_CREATE });
    const excludeFilePath = `${archivePath}.exclude`;
    let shouldCleanupExcludeFile = false;

    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;
    let sizeBytes: number | undefined;

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
      // Ensure the work directory exists
      const mkdirResult = await this.sessionManager.executeInSession(
        sessionId,
        `mkdir -p ${shellEscape(BACKUP_WORK_DIR)}`,
        { origin: 'internal' }
      );
      if (!mkdirResult.success) {
        outcome = 'error';
        errorMessage = 'Failed to create backup work directory';
        return serviceError({
          message: `Failed to create backup work directory: ${mkdirResult.error.message}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir, archivePath }
        });
      }

      // Verify the source directory exists
      const checkResult = await this.sessionManager.executeInSession(
        sessionId,
        `test -d ${shellEscape(dir)}`,
        { origin: 'internal' }
      );
      if (!checkResult.success || checkResult.data.exitCode !== 0) {
        errorMessage = 'Source directory does not exist';
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
        `test -x ${BIN.mksquashfs} && echo exists || echo "missing: ${BIN.mksquashfs}"`,
        { origin: 'internal' }
      );
      if (
        checkBinaryResult.success &&
        checkBinaryResult.data.stdout.includes('missing')
      ) {
        errorMessage = 'mksquashfs binary not found';
        return serviceError({
          message: `mksquashfs binary not found at ${BIN.mksquashfs}. Ensure squashfs-tools is installed.`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir, archivePath, binaryPath: BIN.mksquashfs }
        });
      }

      const gitignorePatterns = gitignore
        ? await this.resolveGitignoreExcludePatterns(dir, sessionId, opLogger)
        : [];

      const userExcludePatterns = excludes.flatMap((pattern) => [
        pattern,
        `... ${pattern}`
      ]);

      const excludePatterns = [
        ...new Set([...gitignorePatterns, ...userExcludePatterns])
      ];

      if (excludePatterns.length > 0) {
        const writeExcludeResult = await this.sessionManager.executeInSession(
          sessionId,
          `printf '%s\\n' ${excludePatterns.map(shellEscape).join(' ')} > ${shellEscape(excludeFilePath)}`,
          { origin: 'internal' }
        );
        if (
          !writeExcludeResult.success ||
          writeExcludeResult.data.exitCode !== 0
        ) {
          shouldCleanupExcludeFile = true;
          errorMessage = 'Failed to write exclude patterns file';
          return serviceError({
            message: 'Failed to write exclude patterns file',
            code: ErrorCode.BACKUP_CREATE_FAILED,
            details: { dir, archivePath }
          });
        }
        shouldCleanupExcludeFile = true;
      }

      // Create squashfs archive with zstd compression
      // -no-progress suppresses progress output
      // -noappend creates a fresh archive (no appending to existing)
      const squashCmdParts = [
        BIN.mksquashfs,
        shellEscape(dir),
        shellEscape(archivePath),
        '-comp zstd',
        '-no-progress',
        '-noappend'
      ];
      if (excludePatterns.length > 0) {
        squashCmdParts.push('-wildcards');
        squashCmdParts.push(`-ef ${shellEscape(excludeFilePath)}`);
      }
      const squashCmd = squashCmdParts.join(' ');

      const createResult = await this.sessionManager.executeInSession(
        sessionId,
        squashCmd,
        { origin: 'internal' }
      );

      if (!createResult.success) {
        errorMessage = 'Failed to create squashfs archive';
        return serviceError({
          message: `Failed to create squashfs archive: ${createResult.error.message}`,
          code: ErrorCode.BACKUP_CREATE_FAILED,
          details: { dir, archivePath }
        });
      }

      if (createResult.data.exitCode !== 0) {
        errorMessage = 'mksquashfs failed';
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
        `stat -c %s ${shellEscape(archivePath)}`,
        { origin: 'internal' }
      );

      sizeBytes = 0;
      if (statResult.success && statResult.data.exitCode === 0) {
        sizeBytes = parseInt(statResult.data.stdout.trim(), 10) || 0;
      }

      outcome = 'success';

      return serviceSuccess<CreateArchiveResult>({
        sizeBytes,
        archivePath
      });
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;
      return serviceError({
        message: `Unexpected error creating backup: ${caughtError.message}`,
        code: ErrorCode.BACKUP_CREATE_FAILED,
        details: { dir, archivePath }
      });
    } finally {
      if (shouldCleanupExcludeFile) {
        await this.sessionManager
          .executeInSession(
            sessionId,
            `rm -f ${shellEscape(excludeFilePath)}`,
            { origin: 'internal' }
          )
          .catch((err) => {
            opLogger.warn('Failed to clean up exclude file', {
              excludeFilePath,
              error: err instanceof Error ? err.message : String(err)
            });
          });
      }

      logCanonicalEvent(this.logger, {
        event: 'backup.create',
        outcome,
        durationMs: Date.now() - startTime,
        path: dir,
        archivePath,
        sizeBytes,
        errorMessage,
        error: caughtError
      });
    }
  }

  private async resolveGitignoreExcludePatterns(
    dir: string,
    sessionId: string,
    opLogger: Logger
  ): Promise<string[]> {
    const gitAvailableResult = await this.sessionManager.executeInSession(
      sessionId,
      'command -v git >/dev/null 2>&1',
      { origin: 'internal' }
    );
    if (!gitAvailableResult.success || gitAvailableResult.data.exitCode !== 0) {
      opLogger.warn(
        'gitignore option enabled but git is not installed; skipping git-based exclusions',
        { dir }
      );
      return [];
    }

    const insideWorkTreeResult = await this.sessionManager.executeInSession(
      sessionId,
      `git -C ${shellEscape(dir)} rev-parse --is-inside-work-tree`,
      { origin: 'internal' }
    );
    if (
      !insideWorkTreeResult.success ||
      insideWorkTreeResult.data.exitCode !== 0 ||
      insideWorkTreeResult.data.stdout.trim() !== 'true'
    ) {
      opLogger.debug('Backup directory is not inside a git repository', {
        dir
      });
      return [];
    }

    // Scope the query to the backup directory so Git returns ignored paths
    // relative to the directory mksquashfs will archive.
    // Use core.quotePath=false to ensure special characters (spaces, unicode)
    // are output literally rather than quoted, so they match archive entries.
    const ignoredFilesResult = await this.sessionManager.executeInSession(
      sessionId,
      `git -C ${shellEscape(dir)} -c core.quotePath=false ls-files --others -i --exclude-standard -- .`,
      { origin: 'internal' }
    );
    if (!ignoredFilesResult.success || ignoredFilesResult.data.exitCode !== 0) {
      opLogger.warn('Failed to resolve gitignored backup paths', { dir });
      return [];
    }

    const relativePaths = ignoredFilesResult.data.stdout
      .split('\n')
      .map((line) => line.trim().replace(/\/+$/, ''))
      .filter((line) => line.length > 0)
      .map(BackupService.escapeMksquashfsWildcardLiteral);

    // Include both direct relative paths and sticky "... " patterns.
    // mksquashfs path matching differs depending on how the source directory
    // is represented in the archive, so emitting both forms ensures ignored
    // content is excluded whether entries appear at the archive root or below
    // the source directory basename.
    const excludePatterns = relativePaths.flatMap((path) => [
      path,
      `... ${path}`
    ]);
    return [...new Set(excludePatterns)];
  }

  private static escapeMksquashfsWildcardLiteral(path: string): string {
    return path.replace(/\\/g, '\\\\').replace(/([*?[\]])/g, '\\$1');
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

      // Each restore uses a unique mount base so stale upper-layer files from a
      // previous overlay session cannot leak into a new mount.  Old mount bases
      // for this backup ID are torn down (best-effort) before the new mount.
      const restoreId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const mountBase = `${BACKUP_MOUNTS_DIR}/${backupId}_${restoreId}`;
      const lowerDir = `${mountBase}/lower`;
      const upperDir = `${mountBase}/upper`;
      const workDir = `${mountBase}/work`;
      // Verify the archive exists
      const checkResult = await this.sessionManager.executeInSession(
        sessionId,
        `test -f ${shellEscape(archivePath)}`,
        { origin: 'internal' }
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
      await this.sessionManager.executeInSession(
        sessionId,
        `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null; ${BIN.fusermount} -uz ${shellEscape(dir)} 2>/dev/null; true`,
        { origin: 'internal' }
      );

      // Tear down all previous mount bases for this backup ID.
      // Each old mount base may have squashfuse on its lower dir; unmount
      // those before removing the directories.  The glob covers both the
      // new suffixed layout (UUID_*) and the legacy unsuffixed layout (UUID/).
      const mountGlob = `${BACKUP_MOUNTS_DIR}/${backupId}`;
      await this.sessionManager.executeInSession(
        sessionId,
        `for d in ${shellEscape(mountGlob)}_*/lower ${shellEscape(mountGlob)}/lower; do [ -d "$d" ] && ${BIN.fusermount} -u "$d" 2>/dev/null; ${BIN.fusermount} -uz "$d" 2>/dev/null; done; true`,
        { origin: 'internal' }
      );

      // Remove old mount bases (best-effort)
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -rf ${shellEscape(mountGlob)}_* ${shellEscape(mountGlob)} 2>/dev/null; true`,
        { origin: 'internal' }
      );

      // Create fresh mount directories
      const mkdirResult = await this.sessionManager.executeInSession(
        sessionId,
        `mkdir -p ${shellEscape(lowerDir)} ${shellEscape(upperDir)} ${shellEscape(workDir)} ${shellEscape(dir)}`,
        { origin: 'internal' }
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
      const squashMountResult = await this.sessionManager.executeInSession(
        sessionId,
        squashMountCmd,
        { origin: 'internal' }
      );
      if (!squashMountResult.success) {
        errorMessage = 'Failed to mount squashfs';
        return serviceError({
          message: `Failed to mount squashfs: ${squashMountResult.error.message}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, archivePath, cmd: squashMountCmd }
        });
      }
      if (squashMountResult.data.exitCode !== 0) {
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

      const overlayMountResult = await this.sessionManager.executeInSession(
        sessionId,
        overlayMountCmd,
        { origin: 'internal' }
      );
      if (!overlayMountResult.success) {
        // Cleanup: unmount squashfs on failure
        await this.sessionManager.executeInSession(
          sessionId,
          `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || true`,
          { origin: 'internal' }
        );
        errorMessage = 'Failed to mount overlayfs';
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
          `${BIN.fusermount} -u ${shellEscape(lowerDir)} 2>/dev/null || true`,
          { origin: 'internal' }
        );
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
      await this.sessionManager
        .executeInSession(
          sessionId,
          `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null || true`,
          { origin: 'internal' }
        )
        .catch(() => {});
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

    const mountGlob = `${BACKUP_MOUNTS_DIR}/${backupId}`;

    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;

    try {
      // Unmount overlayfs first
      await this.sessionManager.executeInSession(
        sessionId,
        `${BIN.fusermount} -u ${shellEscape(dir)} 2>/dev/null || umount ${shellEscape(dir)} 2>/dev/null || true`,
        { origin: 'internal' }
      );

      // Unmount squashfuse on all mount bases for this backup ID
      // (both suffixed UUID_* and legacy unsuffixed UUID)
      await this.sessionManager.executeInSession(
        sessionId,
        `for d in ${shellEscape(mountGlob)}_*/lower ${shellEscape(mountGlob)}/lower; do [ -d "$d" ] && ${BIN.fusermount} -u "$d" 2>/dev/null; done; true`,
        { origin: 'internal' }
      );

      // Verify overlay mount is gone before removing directories
      const mountCheck = await this.sessionManager.executeInSession(
        sessionId,
        `mountpoint -q ${shellEscape(dir)} 2>/dev/null && echo "mounted" || echo "unmounted"`,
        { origin: 'internal' }
      );
      if (mountCheck.success && mountCheck.data.stdout.trim() === 'mounted') {
        errorMessage = `Overlay mount still active at ${dir}`;
        return serviceError({
          message: `Failed to unmount overlay at ${dir}. Mount is still active.`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { dir, backupId }
        });
      }

      // Clean up all mount directories for this backup ID (but keep the archive)
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -rf ${shellEscape(mountGlob)}_* ${shellEscape(mountGlob)} 2>/dev/null; true`,
        { origin: 'internal' }
      );

      outcome = 'success';

      return serviceSuccess({ success: true });
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;
      return serviceError({
        message: `Failed to unmount snapshot: ${caughtError.message}`,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { dir, backupId }
      });
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'backup.unmount',
        outcome,
        durationMs: Date.now() - startTime,
        dir,
        backupId,
        errorMessage,
        error: caughtError
      });
    }
  }
}
