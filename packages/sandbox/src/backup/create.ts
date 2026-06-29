import type {
  BackupOptions,
  DirectoryBackup,
  ExecOptions,
  ExecResult
} from '@repo/shared';
import {
  type createLogger,
  logCanonicalEvent,
  shellEscape
} from '@repo/shared';
import type { ContainerControlClient } from '../container-control';
import {
  BackupCreateError,
  ErrorCode,
  InvalidBackupConfigError
} from '../errors';
import { streamFile } from '../file-stream';
import { isR2Bucket } from '../storage-mount';
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
  getClient: () => ContainerControlClient;
  logger: ReturnType<typeof createLogger>;
  transfer: BackupTransfer;
  ensureBackupSession: () => Promise<string>;
  execWithSession: (
    command: string,
    sessionId: string,
    options?: ExecOptions
  ) => Promise<ExecResult>;
};

export class BackupCreator {
  constructor(private readonly deps: BackupCreatorDeps) {}

  private get env(): unknown {
    return this.deps.getEnv();
  }

  private get client(): ContainerControlClient {
    return this.deps.getClient();
  }

  private get logger(): ReturnType<typeof createLogger> {
    return this.deps.logger;
  }

  private get transfer(): BackupTransfer {
    return this.deps.transfer;
  }

  private ensureBackupSession(): Promise<string> {
    return this.deps.ensureBackupSession();
  }

  private execWithSession(
    command: string,
    sessionId: string,
    options?: ExecOptions
  ): Promise<ExecResult> {
    return this.deps.execWithSession(command, sessionId, options);
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
    let backupSession: string | undefined;

    try {
      validateBackupDir(dir, 'BackupOptions.dir');
      if (name !== undefined) {
        if (typeof name !== 'string' || name.length > BACKUP_MAX_NAME_LENGTH) {
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
        // Reject control characters (could cause issues in R2 metadata or downstream systems)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars
        if (/[\u0000-\u001f\u007f]/.test(name)) {
          throw new InvalidBackupConfigError({
            message: 'BackupOptions.name must not contain control characters',
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: { reason: 'name must not contain control characters' },
            timestamp: new Date().toISOString()
          });
        }
      }
      if (ttl <= 0) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.ttl must be a positive number of seconds',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'ttl must be a positive number of seconds' },
          timestamp: new Date().toISOString()
        });
      }

      if (typeof gitignore !== 'boolean') {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.gitignore must be a boolean',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'gitignore must be a boolean' },
          timestamp: new Date().toISOString()
        });
      }

      if (
        !Array.isArray(excludes) ||
        !excludes.every((e: unknown) => typeof e === 'string')
      ) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.excludes must be an array of strings',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'excludes must be an array of strings' },
          timestamp: new Date().toISOString()
        });
      }

      const resolvedCompression = resolveBackupCompression(compression);

      const normalizedExcludes = normalizeBackupExcludes(excludes, this.logger);

      backupSession = await this.ensureBackupSession();
      backupId = crypto.randomUUID();
      const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;

      const createResult = await this.client.backup.createArchive(
        dir,
        archivePath,
        backupSession,
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
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;

      // Step 2: Upload archive to R2
      if (multipart && createResult.sizeBytes >= BACKUP_MULTIPART_MIN_SIZE) {
        await this.transfer.uploadBackupMultipart(
          archivePath,
          r2Key,
          createResult.sizeBytes,
          backupId,
          dir,
          backupSession
        );
      } else {
        await this.transfer.uploadBackupPresigned(
          archivePath,
          r2Key,
          createResult.sizeBytes,
          backupId,
          dir,
          backupSession
        );
      }

      // Step 3: Write metadata alongside the archive
      const metadata = {
        id: backupId,
        dir,
        name: name || null,
        sizeBytes: createResult.sizeBytes,
        ttl,
        createdAt: new Date().toISOString()
      };
      await bucket.put(metaKey, JSON.stringify(metadata));

      outcome = 'success';

      // Clean up the local archive in the container
      await this.execWithSession(
        `rm -f ${shellEscape(archivePath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});

      return { id: backupId, dir };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      // Clean up local archive and any partially-uploaded R2 objects
      if (backupId && backupSession) {
        const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;
        const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
        const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;
        await this.execWithSession(
          `rm -f ${shellEscape(archivePath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        await bucket.delete(r2Key).catch(() => {});
        await bucket.delete(metaKey).catch(() => {});
      }
      throw error;
    } finally {
      if (backupSession) {
        await this.client.utils.deleteSession(backupSession).catch(() => {});
      }
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
    let backupSession: string | undefined;

    // Resolve backup bucket from env as an R2 binding
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
      validateBackupDir(dir, 'BackupOptions.dir');
      if (name !== undefined) {
        if (typeof name !== 'string' || name.length > BACKUP_MAX_NAME_LENGTH) {
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
        if (/[\u0000-\u001f\u007f]/.test(name)) {
          throw new InvalidBackupConfigError({
            message: 'BackupOptions.name must not contain control characters',
            code: ErrorCode.INVALID_BACKUP_CONFIG,
            httpStatus: 400,
            context: { reason: 'name must not contain control characters' },
            timestamp: new Date().toISOString()
          });
        }
      }
      if (ttl <= 0) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.ttl must be a positive number of seconds',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'ttl must be a positive number of seconds' },
          timestamp: new Date().toISOString()
        });
      }
      if (typeof gitignore !== 'boolean') {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.gitignore must be a boolean',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'gitignore must be a boolean' },
          timestamp: new Date().toISOString()
        });
      }
      if (
        !Array.isArray(excludes) ||
        !excludes.every((e: unknown) => typeof e === 'string')
      ) {
        throw new InvalidBackupConfigError({
          message: 'BackupOptions.excludes must be an array of strings',
          code: ErrorCode.INVALID_BACKUP_CONFIG,
          httpStatus: 400,
          context: { reason: 'excludes must be an array of strings' },
          timestamp: new Date().toISOString()
        });
      }

      const resolvedCompression = resolveBackupCompression(compression);

      const normalizedExcludes = normalizeBackupExcludes(excludes, this.logger);

      backupSession = await this.ensureBackupSession();
      backupId = crypto.randomUUID();
      const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;

      // Step 1: Create squashfs archive in the container (same as production)
      const createResult = await this.client.backup.createArchive(
        dir,
        archivePath,
        backupSession,
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
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;

      // Step 2: Read archive from container and stream it into R2 via binding.
      // readFileStream returns SSE-framed base64 chunks, so we pipe it through
      // streamFile (which decodes SSE frames + base64 on the fly) into a
      // FixedLengthStream backed by the known archive size. This avoids
      // buffering the whole archive in Worker memory.
      const archiveStream = await this.client.files.readFileStream(
        archivePath,
        backupSession
      );
      const sseDecoded = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of streamFile(archiveStream)) {
              if (chunk instanceof Uint8Array) {
                controller.enqueue(chunk);
              }
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        }
      });
      const fixedStream = new FixedLengthStream(createResult.sizeBytes);
      sseDecoded.pipeTo(fixedStream.writable).catch(() => {});
      await bucket.put(r2Key, fixedStream.readable);

      // Verify upload — size comes from createArchive result, not the stream.
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

      // Step 3: Write metadata
      const metadata = {
        id: backupId,
        dir,
        name: name || null,
        sizeBytes: createResult.sizeBytes,
        ttl,
        createdAt: new Date().toISOString()
      };
      await bucket.put(metaKey, JSON.stringify(metadata));

      outcome = 'success';

      // Clean up local archive
      await this.execWithSession(
        `rm -f ${shellEscape(archivePath)}`,
        backupSession,
        { origin: 'internal' }
      ).catch(() => {});

      return { id: backupId, dir, localBucket: true };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      if (backupId && backupSession) {
        const archivePath = `${BACKUP_CONTAINER_DIR}/${backupId}.sqsh`;
        const r2Key = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
        const metaKey = `${BACKUP_STORAGE_PREFIX}/${backupId}/${BACKUP_METADATA_OBJECT_NAME}`;
        await this.execWithSession(
          `rm -f ${shellEscape(archivePath)}`,
          backupSession,
          { origin: 'internal' }
        ).catch(() => {});
        await bucket.delete(r2Key).catch(() => {});
        await bucket.delete(metaKey).catch(() => {});
      }
      throw error;
    } finally {
      if (backupSession) {
        await this.client.utils.deleteSession(backupSession).catch(() => {});
      }
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
