import type { BackupOptions, DirectoryBackup } from '@repo/shared';
import { type createLogger, logCanonicalEvent } from '@repo/shared';
import {
  BackupCreateError,
  ErrorCode,
  InvalidBackupConfigError
} from '../errors';
import { streamFile } from '../file-stream';
import { isR2Bucket } from '../storage-mount';
import type { BackupAttemptLease } from './backup-service';
import {
  BACKUP_ARCHIVE_OBJECT_NAME,
  BACKUP_CONTAINER_DIR,
  BACKUP_DEFAULT_TTL_SECONDS,
  BACKUP_MAX_NAME_LENGTH,
  BACKUP_METADATA_OBJECT_NAME,
  BACKUP_MULTIPART_MIN_SIZE,
  BACKUP_STORAGE_PREFIX
} from './constants';
import type { BackupTransfer } from './transfer';
import {
  normalizeBackupExcludes,
  resolveBackupCompression,
  validateBackupDir
} from './validation';

type BackupCreatorDeps = {
  getEnv: () => unknown;
  runBackupAttempt<T>(
    operation: string,
    call: (lease: BackupAttemptLease) => Promise<T>
  ): Promise<T>;
  logger: ReturnType<typeof createLogger>;
  transfer: BackupTransfer;
};

export class BackupCreator {
  constructor(private readonly deps: BackupCreatorDeps) {}

  private get env(): unknown {
    return this.deps.getEnv();
  }

  private get logger(): ReturnType<typeof createLogger> {
    return this.deps.logger;
  }

  private get transfer(): BackupTransfer {
    return this.deps.transfer;
  }

  async createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    if (options.localBucket) {
      return await this.doCreateBackupLocal(options);
    }
    this.transfer.requireBackupBucket();
    return await this.doCreateBackup(options);
  }

  private async doCreateBackup(
    options: BackupOptions
  ): Promise<DirectoryBackup> {
    const bucket = this.transfer.requireBackupBucket();
    this.transfer.requirePresignedURLSupport();
    const {
      dir,
      name,
      ttl = BACKUP_DEFAULT_TTL_SECONDS,
      gitignore = false,
      excludes = [],
      compression,
      multipart = true
    } = options;

    const backupStartTime = Date.now();
    let backupId: string | undefined;
    let sizeBytes: number | undefined;
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;

    try {
      this.validateOptions({ dir, name, ttl, gitignore, excludes });

      const resolvedCompression = resolveBackupCompression(compression);
      const normalizedExcludes = normalizeBackupExcludes(excludes, this.logger);
      const currentBackupId = crypto.randomUUID();
      backupId = currentBackupId;
      const archivePath = `${BACKUP_CONTAINER_DIR}/${currentBackupId}.sqsh`;
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${currentBackupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${currentBackupId}/${BACKUP_METADATA_OBJECT_NAME}`;

      const result = await this.deps.runBackupAttempt(
        'backup.create',
        async ({ control }) => {
          try {
            const createResult = await control.backup.createArchive(
              dir,
              archivePath,
              {
                gitignore,
                excludes: normalizedExcludes,
                compression: resolvedCompression
              }
            );

            if (!createResult.success) {
              throw new BackupCreateError({
                message: 'Container failed to create backup archive',
                code: ErrorCode.BACKUP_CREATE_FAILED,
                httpStatus: 500,
                context: { dir, backupId },
                timestamp: new Date().toISOString()
              });
            }

            sizeBytes = createResult.sizeBytes;
            if (
              multipart &&
              createResult.sizeBytes >= BACKUP_MULTIPART_MIN_SIZE
            ) {
              await this.transfer.uploadBackupMultipart(
                archivePath,
                r2Key,
                createResult.sizeBytes,
                currentBackupId,
                dir,
                control
              );
            } else {
              await this.transfer.uploadBackupPresigned(
                archivePath,
                r2Key,
                createResult.sizeBytes,
                currentBackupId,
                dir,
                control
              );
            }

            const metadata = {
              id: currentBackupId,
              dir,
              name: name || null,
              sizeBytes: createResult.sizeBytes,
              ttl,
              createdAt: new Date().toISOString()
            };
            await bucket.put(metaKey, JSON.stringify(metadata));

            outcome = 'success';
            await control.backup.cleanupArchive(archivePath).catch(() => {});
            return { id: currentBackupId, dir };
          } catch (error) {
            await control.backup.cleanupArchive(archivePath).catch(() => {});
            await bucket.delete(r2Key).catch(() => {});
            await bucket.delete(metaKey).catch(() => {});
            throw error;
          }
        }
      );

      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'backup.create',
        outcome,
        durationMs: Date.now() - backupStartTime,
        backupId,
        dir,
        name,
        sizeBytes,
        error: caughtError
      });
    }
  }

  private validateOptions(options: {
    dir: string;
    name: string | undefined;
    ttl: number;
    gitignore: boolean;
    excludes: string[];
  }): void {
    validateBackupDir(options.dir, 'BackupOptions.dir');
    if (options.name !== undefined) {
      if (
        typeof options.name !== 'string' ||
        options.name.length > BACKUP_MAX_NAME_LENGTH
      ) {
        throw new InvalidBackupConfigError({
          message: `BackupOptions.name must be a string of at most ${BACKUP_MAX_NAME_LENGTH} characters`,
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: {
            reason: `name must be a string of at most ${BACKUP_MAX_NAME_LENGTH} characters`
          },
          timestamp: new Date().toISOString()
        });
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
      if (/[\u0000-\u001f\u007f]/.test(options.name)) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.name must not contain control characters',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'name must not contain control characters' },
          timestamp: new Date().toISOString()
        });
      }
    }
    if (options.ttl <= 0) {
      throw new InvalidBackupConfigError({
        message: 'BackupOptions.ttl must be a positive number of seconds',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'ttl must be a positive number of seconds' },
        timestamp: new Date().toISOString()
      });
    }
    if (typeof options.gitignore !== 'boolean') {
      throw new InvalidBackupConfigError({
        message: 'BackupOptions.gitignore must be a boolean',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'gitignore must be a boolean' },
        timestamp: new Date().toISOString()
      });
    }
    if (
      !Array.isArray(options.excludes) ||
      !options.excludes.every((e: unknown) => typeof e === 'string')
    ) {
      throw new InvalidBackupConfigError({
        message: 'BackupOptions.excludes must be an array of strings',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'excludes must be an array of strings' },
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Local-dev implementation of createBackup.
   * Uses the R2 binding directly instead of presigned URLs.
   * Archive format is identical to production (squashfs + meta.json).
   */
  private async doCreateBackupLocal(
    options: BackupOptions
  ): Promise<DirectoryBackup> {
    const {
      dir,
      name,
      ttl = BACKUP_DEFAULT_TTL_SECONDS,
      gitignore = false,
      excludes = [],
      compression
    } = options;

    const backupStartTime = Date.now();
    let backupId: string | undefined;
    let sizeBytes: number | undefined;
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;

    const envObj = this.env as Record<string, unknown>;
    const bucket = envObj.BACKUP_BUCKET;
    if (!bucket || !isR2Bucket(bucket)) {
      throw new InvalidBackupConfigError({
        message:
          'BACKUP_BUCKET R2 binding not found in env. ' +
          'Add a BACKUP_BUCKET R2 binding to your wrangler.jsonc for local backup support.',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'Missing BACKUP_BUCKET R2 binding' },
        timestamp: new Date().toISOString()
      });
    }

    try {
      this.validateOptions({ dir, name, ttl, gitignore, excludes });
      const resolvedCompression = resolveBackupCompression(compression);
      const normalizedExcludes = normalizeBackupExcludes(excludes, this.logger);

      const currentBackupId = crypto.randomUUID();
      backupId = currentBackupId;
      const archivePath = `${BACKUP_CONTAINER_DIR}/${currentBackupId}.sqsh`;
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${currentBackupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${currentBackupId}/${BACKUP_METADATA_OBJECT_NAME}`;

      const result = await this.deps.runBackupAttempt(
        'backup.create',
        async ({ control }) => {
          try {
            const createResult = await control.backup.createArchive(
              dir,
              archivePath,
              {
                gitignore,
                excludes: normalizedExcludes,
                compression: resolvedCompression
              }
            );

            if (!createResult.success) {
              throw new BackupCreateError({
                message: 'Container failed to create backup archive',
                code: ErrorCode.BACKUP_CREATE_FAILED,
                httpStatus: 500,
                context: { dir, backupId },
                timestamp: new Date().toISOString()
              });
            }

            sizeBytes = createResult.sizeBytes;
            const archiveStream = await control.files.readFileStream(
              archivePath,
              {}
            );
            const fixedStream = new FixedLengthStream(createResult.sizeBytes);
            const writer = fixedStream.writable.getWriter();
            const uploadArchive = bucket
              .put(r2Key, fixedStream.readable)
              .catch(async (error) => {
                await writer.abort(error).catch(() => {});
                throw error;
              });
            const decodeAndWrite = (async () => {
              try {
                for await (const chunk of streamFile(archiveStream)) {
                  if (chunk instanceof Uint8Array) {
                    await writer.write(chunk);
                  }
                }
                await writer.close();
              } catch (error) {
                await writer.abort(error).catch(() => {});
                throw error;
              }
            })();
            const results = await Promise.allSettled([
              decodeAndWrite,
              uploadArchive
            ]);
            const rejected = [...results]
              .reverse()
              .find((result) => result.status === 'rejected');
            if (rejected) throw rejected.reason;

            const head = await bucket.head(r2Key);
            if (!head || head.size !== createResult.sizeBytes) {
              throw new BackupCreateError({
                message: `Upload verification failed: expected ${createResult.sizeBytes} bytes, got ${head?.size ?? 0}`,
                code: ErrorCode.BACKUP_CREATE_FAILED,
                httpStatus: 500,
                context: { dir, backupId },
                timestamp: new Date().toISOString()
              });
            }

            const metadata = {
              id: currentBackupId,
              dir,
              name: name || null,
              sizeBytes: createResult.sizeBytes,
              ttl,
              createdAt: new Date().toISOString()
            };
            await bucket.put(metaKey, JSON.stringify(metadata));

            outcome = 'success';
            await control.backup.cleanupArchive(archivePath).catch(() => {});
            return { id: currentBackupId, dir, localBucket: true };
          } catch (error) {
            await control.backup.cleanupArchive(archivePath).catch(() => {});
            await bucket.delete(r2Key).catch(() => {});
            await bucket.delete(metaKey).catch(() => {});
            throw error;
          }
        }
      );

      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'backup.create',
        outcome,
        durationMs: Date.now() - backupStartTime,
        backupId,
        dir,
        name,
        sizeBytes,
        provider: 'local-binding',
        error: caughtError
      });
    }
  }

  /**
   * Restore a backup from R2 into a directory.
   *
   * **Production flow** (`localBucket` not set):
   *   1. DO reads metadata from R2 and checks TTL
   *   2. Container mounts the backup archive from R2 via s3fs
   *   3. Container mounts the squashfs archive with FUSE overlayfs
   *
   * The target directory becomes an overlay mount with the backup as a
   * read-only lower layer and a writable upper layer for copy-on-write.
   * Any processes writing to the directory should be stopped first.
   *
   * **Mount Lifecycle**: The FUSE overlay mount persists only while the
   * container is running. When the sandbox sleeps or the container restarts,
   * the mount is lost and the directory becomes empty. Re-restore from the
   * backup handle to recover. This is an ephemeral restore, not a persistent
   * extraction.
   *
   * **Local-dev flow** (`localBucket: true` on the originating `createBackup` call):
   *   1. DO reads metadata and checks TTL via R2 binding
   *   2. DO downloads the archive from R2 and writes it to the container
   *   3. Container extracts the archive with `unsquashfs` (no FUSE needed)
   *
   * The backup is restored into `backup.dir`. This may differ from the
   * directory that was originally backed up, allowing cross-directory restore.
   *
   * Overlapping backups are independent: restoring a parent directory
   * overwrites everything inside it, including subdirectories that were
   * backed up separately. When restoring both, restore the parent first.
   *
   * Concurrent backup/restore calls on the same sandbox are serialized.
   */
}
