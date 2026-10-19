import type { createLogger } from '@repo/shared';
import {
  BACKUP_ALLOWED_PREFIXES,
  normalizeBackupExcludePattern
} from '@repo/shared/backup';
import { ErrorCode, InvalidBackupConfigError } from '../errors';
import {
  BACKUP_DEFAULT_COMPRESS_THREADS,
  BACKUP_DEFAULT_COMPRESSION
} from './constants';

export function validateBackupDir(dir: string, label: string): void {
  if (!dir || !dir.startsWith('/')) {
    throw new InvalidBackupConfigError({
      message: `${label} must be an absolute path`,
      code: ErrorCode.INVALID_BACKUP_CONFIG,
      httpStatus: 400,
      context: { reason: `${label} must be an absolute path` },
      timestamp: new Date().toISOString()
    });
  }
  if (dir.includes('\0')) {
    throw new InvalidBackupConfigError({
      message: `${label} must not contain null bytes`,
      code: ErrorCode.INVALID_BACKUP_CONFIG,
      httpStatus: 400,
      context: { reason: `${label} must not contain null bytes` },
      timestamp: new Date().toISOString()
    });
  }
  if (dir.split('/').includes('..')) {
    throw new InvalidBackupConfigError({
      message: `${label} must not contain ".." path segments`,
      code: ErrorCode.INVALID_BACKUP_CONFIG,
      httpStatus: 400,
      context: { reason: `${label} must not contain ".." path segments` },
      timestamp: new Date().toISOString()
    });
  }
  const isAllowed = BACKUP_ALLOWED_PREFIXES.some(
    (prefix) => dir === prefix || dir.startsWith(`${prefix}/`)
  );
  if (!isAllowed) {
    throw new InvalidBackupConfigError({
      message: `${label} must be inside one of the supported backup roots (${BACKUP_ALLOWED_PREFIXES.join(', ')})`,
      code: ErrorCode.INVALID_BACKUP_CONFIG,
      httpStatus: 400,
      context: {
        reason: `${label} must be inside one of the supported backup roots`
      },
      timestamp: new Date().toISOString()
    });
  }
}

export function normalizeBackupExcludes(
  excludes: string[],
  logger: ReturnType<typeof createLogger>
): string[] {
  const normalizedExcludes: string[] = [];

  for (const pattern of excludes) {
    const normalized = normalizeBackupExcludePattern(pattern);
    if (normalized === null) {
      logger.warn(
        'Exclude pattern reduced to empty after globstar normalization; skipping',
        { original: pattern }
      );
      continue;
    }
    if (normalized !== pattern) {
      logger.warn(
        'Exclude pattern contained ** (globstar) which mksquashfs does not support; normalized automatically',
        { original: pattern, normalized }
      );
    }
    normalizedExcludes.push(normalized);
  }

  return normalizedExcludes;
}

export function resolveBackupCompression(compression: unknown): {
  format: 'gzip' | 'lz4' | 'zstd';
  threads: number;
} {
  if (compression !== undefined) {
    if (typeof compression !== 'object' || compression === null) {
      throw new InvalidBackupConfigError({
        message: 'BackupOptions.compression must be an object',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'compression must be an object' },
        timestamp: new Date().toISOString()
      });
    }
  }

  const compressionOptions = compression as
    | { format?: unknown; threads?: unknown }
    | undefined;
  const format = compressionOptions?.format ?? BACKUP_DEFAULT_COMPRESSION;
  const threads =
    compressionOptions?.threads ?? BACKUP_DEFAULT_COMPRESS_THREADS;
  const allowedCompressions = ['gzip', 'lz4', 'zstd'];

  if (
    typeof format !== 'string' ||
    !allowedCompressions.includes(
      format as (typeof allowedCompressions)[number]
    )
  ) {
    throw new InvalidBackupConfigError({
      message:
        'BackupOptions.compression.format must be one of: gzip, lz4, zstd',
      code: ErrorCode.INVALID_BACKUP_CONFIG,
      httpStatus: 400,
      context: {
        reason: 'compression.format must be one of: gzip, lz4, zstd'
      },
      timestamp: new Date().toISOString()
    });
  }

  if (
    typeof threads !== 'number' ||
    !Number.isInteger(threads) ||
    threads < 1
  ) {
    throw new InvalidBackupConfigError({
      message: 'BackupOptions.compression.threads must be a positive integer',
      code: ErrorCode.INVALID_BACKUP_CONFIG,
      httpStatus: 400,
      context: {
        reason: 'compression.threads must be a positive integer'
      },
      timestamp: new Date().toISOString()
    });
  }

  return {
    format: format as 'gzip' | 'lz4' | 'zstd',
    threads
  };
}
