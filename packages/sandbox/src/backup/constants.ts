export const BACKUP_DEFAULT_TTL_SECONDS = 259200;
export const BACKUP_MAX_NAME_LENGTH = 256;
export const BACKUP_CONTAINER_DIR = '/var/backups';
export const BACKUP_STORAGE_PREFIX = 'backups';
export const BACKUP_ARCHIVE_OBJECT_NAME = 'data.sqsh';
export const BACKUP_METADATA_OBJECT_NAME = 'meta.json';
export const BACKUP_DEFAULT_COMPRESSION = 'lz4';
export const BACKUP_DEFAULT_COMPRESS_THREADS = 8;
export const BACKUP_MULTIPART_MIN_SIZE = 10 * 1024 * 1024;
export const BACKUP_MULTIPART_TARGET_PARTS = 16;
export const BACKUP_MULTIPART_MIN_PART_SIZE = 5 * 1024 * 1024;
export const BACKUP_MULTIPART_MAX_PARTS = 64;
export const BACKUP_DOWNLOAD_PARALLEL_PARTS = 8;
export const BACKUP_DOWNLOAD_PARALLEL_MIN_SIZE = 10 * 1024 * 1024;
export const BACKUP_DOWNLOAD_MAX_PARTS = 64;
export const BACKUP_RESTORE_MAX_RECOVERY_ATTEMPTS = 2;
export const BACKUP_RESTORE_TEST_FAULT_STORAGE_KEY = 'test:backupRestoreFault';

export function calculatePartCount(
  sizeBytes: number,
  defaultParts: number,
  maxParts: number
): number {
  if (sizeBytes < 100 * 1024 * 1024) {
    return defaultParts;
  }
  if (sizeBytes < 1024 * 1024 * 1024) {
    return Math.min(32, defaultParts * 2);
  }
  return maxParts;
}
