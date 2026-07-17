import type { Logger } from '@repo/shared';
import { logCanonicalEvent, shellEscape } from '@repo/shared';
import {
  BACKUP_ALLOWED_PREFIXES,
  normalizeBackupExcludePattern
} from '@repo/shared/backup';
import { ErrorCode, Operation } from '@repo/shared/errors';
import {
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../../core/types';
import type { CommandContextService } from '../command-context-service';
import type { InternalCommandResult } from '../internal-command-result';

export const BACKUP_WORK_DIR = '/var/backups';
export const BACKUP_MOUNTS_DIR = '/var/backups/mounts';
export const BACKUP_UPLOAD_TIMEOUT_MS = 1_800_000;
export const BACKUP_UPLOAD_MAX_ATTEMPTS = 3;
const BACKUP_ALLOWED_COMPRESSIONS = ['gzip', 'lz4', 'zstd'] as const;
type BackupCompression = (typeof BACKUP_ALLOWED_COMPRESSIONS)[number];
export type BackupCreateCompressionOptions = {
  format?: BackupCompression;
  threads?: number;
};

export const BIN = {
  mksquashfs: '/usr/bin/mksquashfs',
  squashfuse: '/usr/bin/squashfuse',
  fuseOverlayfs: '/usr/bin/fuse-overlayfs',
  fusermount: '/usr/bin/fusermount3',
  unsquashfs: '/usr/bin/unsquashfs'
} as const;

function isSafeAbsolutePath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\0')
  );
}

export function validateBackupPaths(
  dir: string,
  archivePath: string
): string | null {
  if (!isSafeAbsolutePath(dir)) {
    return `Backup directory must be a safe absolute path (no '..' or null bytes) under an allowed prefix (${BACKUP_ALLOWED_PREFIXES.join(', ')}): ${dir}`;
  }
  const isAllowed = BACKUP_ALLOWED_PREFIXES.some(
    (prefix) => dir === prefix || dir.startsWith(`${prefix}/`)
  );
  if (!isAllowed) {
    return `Directory not in allowed paths (${BACKUP_ALLOWED_PREFIXES.join(', ')}): ${dir}`;
  }
  return validateArchivePath(archivePath);
}

export function validateArchivePath(archivePath: string): string | null {
  if (!archivePath.startsWith(`${BACKUP_WORK_DIR}/`))
    return 'Invalid archivePath: must use designated backup directory';
  if (archivePath.includes('..'))
    return 'Invalid archivePath: must not contain path traversal sequences';
  if (archivePath.includes('\0'))
    return 'Invalid archivePath: must not contain null bytes';
  return null;
}

export function validateBackupId(backupId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backupId)) {
    return 'Invalid backupId: must be a safe identifier containing only letters, numbers, dot, underscore, or hyphen';
  }
  return null;
}

function isBackupCompression(value: string): value is BackupCompression {
  return BACKUP_ALLOWED_COMPRESSIONS.includes(value as BackupCompression);
}

export interface CreateArchiveResult {
  sizeBytes: number;
  archivePath: string;
}
export interface RestoreArchiveResult {
  dir: string;
}
export interface BackupUploadPart {
  partNumber: number;
  url: string;
  offset: number;
  size: number;
}
export interface UploadedBackupPart {
  partNumber: number;
  etag: string;
}

export class ArchiveOperations {
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

  async createArchive(
    dir: string,
    archivePath: string,
    gitignore = false,
    excludes: string[] = [],
    compression?: BackupCreateCompressionOptions
  ): Promise<ServiceResult<CreateArchiveResult>> {
    const opLogger = this.logger.child({ operation: Operation.BACKUP_CREATE });
    const excludeFilePath = `${archivePath}.exclude`;
    let shouldCleanupExcludeFile = false;
    const compressionFormat = compression?.format ?? 'lz4';
    const compressionThreads = compression?.threads ?? 8;

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
      if (!isBackupCompression(compressionFormat)) {
        errorMessage = 'Invalid compression algorithm';
        return serviceError({
          message: `Invalid compression algorithm: ${compressionFormat}. Expected one of: ${BACKUP_ALLOWED_COMPRESSIONS.join(', ')}`,
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          details: { compression: compressionFormat }
        });
      }
      // Ensure the work directory exists
      const mkdirResult = await this.executeInternal(
        `mkdir -p ${shellEscape(BACKUP_WORK_DIR)}`
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
      const checkResult = await this.executeInternal(
        `test -d ${shellEscape(dir)}`
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
      const checkBinaryResult = await this.executeInternal(
        `test -x ${BIN.mksquashfs} && echo exists || echo "missing: ${BIN.mksquashfs}"`
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
        ? await this.resolveGitignoreExcludePatterns(dir, opLogger)
        : [];

      const normalizedExcludes: string[] = [];
      for (const pattern of excludes) {
        const normalized =
          ArchiveOperations.normalizeMksquashfsPattern(pattern);
        if (normalized === null) {
          opLogger.warn(
            'Exclude pattern reduced to empty after globstar normalization; skipping',
            { original: pattern }
          );
          continue;
        }
        if (normalized !== pattern) {
          opLogger.warn(
            'Exclude pattern contained ** (globstar) which mksquashfs does not support; normalized automatically',
            { original: pattern, normalized }
          );
        }
        normalizedExcludes.push(normalized);
      }

      const userExcludePatterns = normalizedExcludes.flatMap((pattern) => [
        pattern,
        `... ${pattern}`
      ]);

      const excludePatterns = [
        ...new Set([...gitignorePatterns, ...userExcludePatterns])
      ];

      if (excludePatterns.length > 0) {
        const writeExcludeResult = await this.executeInternal(
          `printf '%s\\n' ${excludePatterns.map(shellEscape).join(' ')} > ${shellEscape(excludeFilePath)}`
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

      // Create squashfs archive with configurable compression
      // -no-progress suppresses progress output
      // -noappend creates a fresh archive (no appending to existing)
      const squashCmdParts = [
        BIN.mksquashfs,
        shellEscape(dir),
        shellEscape(archivePath),
        `-comp ${compressionFormat}`,
        `-processors ${Math.max(1, compressionThreads)}`,
        '-no-progress',
        '-noappend'
      ];
      if (excludePatterns.length > 0) {
        squashCmdParts.push('-wildcards');
        squashCmdParts.push(`-ef ${shellEscape(excludeFilePath)}`);
      }
      const squashCmd = squashCmdParts.join(' ');

      const createResult = await this.executeInternal(squashCmd);

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
      const statResult = await this.executeInternal(
        `stat -c %s ${shellEscape(archivePath)}`
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
        await this.executeInternal(
          `rm -f ${shellEscape(excludeFilePath)}`
        ).catch((err) => {
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
    opLogger: Logger
  ): Promise<string[]> {
    const gitAvailableResult = await this.executeInternal(
      'command -v git >/dev/null 2>&1'
    );
    if (!gitAvailableResult.success || gitAvailableResult.data.exitCode !== 0) {
      opLogger.warn(
        'gitignore option enabled but git is not installed; skipping git-based exclusions',
        { dir }
      );
      return [];
    }

    const insideWorkTreeResult = await this.executeInternal(
      `git -C ${shellEscape(dir)} rev-parse --is-inside-work-tree`
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
    const ignoredFilesResult = await this.executeInternal(
      `git -C ${shellEscape(dir)} -c core.quotePath=false ls-files --others -i --exclude-standard -- .`
    );
    if (!ignoredFilesResult.success || ignoredFilesResult.data.exitCode !== 0) {
      opLogger.warn('Failed to resolve gitignored backup paths', { dir });
      return [];
    }

    const relativePaths = ignoredFilesResult.data.stdout
      .split('\n')
      .map((line) => line.trim().replace(/\/+$/, ''))
      .filter((line) => line.length > 0)
      .map(ArchiveOperations.escapeMksquashfsWildcardLiteral);

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
   * Normalize a user-provided exclude pattern for mksquashfs compatibility.
   * mksquashfs uses fnmatch-style wildcards which do not support ** (globstar).
   * The mksquashfs "... " prefix already provides recursive directory matching,
   * making leading ** redundant. Returns null if the pattern reduces to empty.
   */
  static normalizeMksquashfsPattern(pattern: string): string | null {
    return normalizeBackupExcludePattern(pattern);
  }
}
