import type {
  BackupOptions,
  DirectoryBackup,
  RestoreBackupResult
} from '@repo/shared';
import { type createLogger, logCanonicalEvent } from '@repo/shared';
import type { ContainerControlClient } from '../container-control';
import {
  BackupCreateError,
  BackupExpiredError,
  BackupNotFoundError,
  BackupRestoreError,
  ErrorCode,
  InvalidBackupConfigError
} from '../errors';
import type { RuntimeIdentity, RuntimeIdentityReader } from '../runtime';
import type { CurrentSandboxLifetime } from '../sandbox-lifetime';
import { isR2Bucket } from '../storage-mount';
import {
  BACKUP_ARCHIVE_OBJECT_NAME,
  BACKUP_CONTAINER_DIR,
  BACKUP_METADATA_OBJECT_NAME,
  BACKUP_STORAGE_PREFIX
} from './constants';
import { BackupCreator } from './create';
import {
  type BackupRestoreTestFault,
  StorageBackedBackupRestoreFaultInjector
} from './restore-fault-injection';
import {
  type RestoreLifecycleContext,
  RestoreLifecycleRunner
} from './restore-lifecycle';
import type { BackupRestoreOperationResult } from './restore-operation-store';
import { BackupTransfer } from './transfer';
import { validateBackupDir } from './validation';

export type { BackupRestoreTestFault } from './restore-fault-injection';

export type BackupAttemptLease = {
  runtime: RuntimeIdentity;
  control: ContainerControlClient;
  retain(onInterrupt?: () => void): { release(): void };
};

type BackupAttemptCall = <T>(
  operation: string,
  call: (lease: BackupAttemptLease) => Promise<T>
) => Promise<T>;

type BackupServiceDeps = {
  ctx: DurableObjectState<{}>;
  getEnv: () => unknown;
  logger: ReturnType<typeof createLogger>;
  runBackupAttempt: BackupAttemptCall;
  runtimeReader: RuntimeIdentityReader;
  currentLifetime: CurrentSandboxLifetime;
};

export class BackupService {
  private readonly ctx: DurableObjectState<{}>;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly creator: BackupCreator;
  private readonly restoreFaults: StorageBackedBackupRestoreFaultInjector;
  private readonly restoreLifecycle: RestoreLifecycleRunner;
  private readonly transfer: BackupTransfer;
  private backupInProgress: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BackupServiceDeps) {
    this.ctx = deps.ctx;
    this.logger = deps.logger;
    this.restoreFaults = new StorageBackedBackupRestoreFaultInjector(
      this.ctx.storage,
      deps.getEnv
    );
    this.restoreLifecycle = new RestoreLifecycleRunner({
      storage: this.ctx.storage,
      runtimeReader: deps.runtimeReader,
      currentLifetime: deps.currentLifetime,
      faultInjector: this.restoreFaults
    });
    this.transfer = new BackupTransfer({
      getEnv: deps.getEnv,
      logger: deps.logger
    });
    this.creator = new BackupCreator({
      getEnv: deps.getEnv,
      runBackupAttempt: deps.runBackupAttempt,
      logger: deps.logger,
      transfer: this.transfer
    });
  }

  private get env(): unknown {
    return this.deps.getEnv();
  }

  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Serialize backup operations so concurrent calls run one at a time.
   */
  private async enqueueBackupOp<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.backupInProgress;
    } catch {
      // Previous backup/restore failure should not poison later operations.
    }

    const next = fn();
    this.backupInProgress = next.catch(() => {});
    return await next;
  }

  /**
   * Create a backup of a directory and upload it to R2.
   *
   * Flow:
   *   1. Container creates squashfs archive from the directory
   *   2. Container uploads the archive directly to R2 via presigned URL
   *   3. DO writes metadata to R2
   *   4. Container cleans up the local archive
   *
   * The returned DirectoryBackup handle is serializable. Store it anywhere
   * (KV, D1, DO storage) and pass it to restoreBackup() later.
   *
   * Concurrent backup/restore calls on the same sandbox are serialized.
   *
   * Partially-written files in the target directory may not be captured
   * consistently. Completed writes are captured.
   *
   * NOTE: Expired backups are not automatically deleted from R2. Configure
   * R2 lifecycle rules on the BACKUP_BUCKET to garbage-collect objects
   * under the `backups/` prefix after the desired retention period.
   */
  async createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    return await this.enqueueBackupOp(() => this.creator.createBackup(options));
  }

  async restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult> {
    const { id, dir } = this.validateRestoreBackup(backup);
    if (backup.localBucket) {
      return await this.enqueueBackupOp(() =>
        this.restoreLifecycle.execute({
          backupId: id,
          dir,
          attempt: (context) => this.doRestoreBackupLocal(backup, context)
        })
      );
    }
    this.transfer.requireBackupBucket();
    return await this.enqueueBackupOp(() =>
      this.restoreLifecycle.execute({
        backupId: id,
        dir,
        attempt: (context) => this.doRestoreBackup(backup, context)
      })
    );
  }

  private validateRestoreBackup(backup: DirectoryBackup): {
    id: string;
    dir: string;
  } {
    const { id, dir } = backup;
    if (!id || typeof id !== 'string') {
      throw new InvalidBackupConfigError({
        message: 'Invalid backup: missing or invalid id',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'missing or invalid id' },
        timestamp: new Date().toISOString()
      });
    }
    if (!BackupService.UUID_REGEX.test(id)) {
      throw new InvalidBackupConfigError({
        message:
          'Invalid backup: id must be a valid UUID (e.g. from createBackup)',
        code: ErrorCode.INVALID_BACKUP_CONFIG,
        httpStatus: 400,
        context: { reason: 'id must be a valid UUID' },
        timestamp: new Date().toISOString()
      });
    }
    validateBackupDir(dir, 'Invalid backup: dir');
    return { id, dir };
  }

  async setRestoreFaultForTesting(
    fault: BackupRestoreTestFault | null
  ): Promise<void> {
    await this.restoreFaults.setFaultForTesting(fault);
  }

  private async doRestoreBackup(
    backup: DirectoryBackup,
    lifecycle: RestoreLifecycleContext
  ): Promise<BackupRestoreOperationResult> {
    const restoreStartTime = Date.now();
    const bucket = this.transfer.requireBackupBucket();
    this.transfer.requirePresignedURLSupport();
    const { id, dir } = backup;

    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;

    try {
      // Step 1: Read metadata to check TTL
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_METADATA_OBJECT_NAME}`;
      const metaObject = await bucket.get(metaKey);
      if (!metaObject) {
        throw new BackupNotFoundError({
          message:
            `Backup not found: ${id}. ` +
            'Verify the backup ID is correct and the backup has not been deleted.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const metadata = await metaObject.json<{
        ttl: number;
        createdAt: string;
        dir: string;
      }>();

      // Check TTL with 60-second buffer to prevent race between check and restore completion
      const TTL_BUFFER_MS = 60 * 1000;
      const createdAt = new Date(metadata.createdAt).getTime();
      if (Number.isNaN(createdAt)) {
        throw new BackupRestoreError({
          message: `Backup metadata has invalid createdAt timestamp: ${metadata.createdAt}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }
      const expiresAt = createdAt + metadata.ttl * 1000;
      if (Date.now() + TTL_BUFFER_MS > expiresAt) {
        throw new BackupExpiredError({
          message:
            `Backup ${id} has expired ` +
            `(created: ${metadata.createdAt}, TTL: ${metadata.ttl}s). ` +
            'Create a new backup.',
          code: ErrorCode.BACKUP_EXPIRED,
          httpStatus: 400,
          context: {
            backupId: id,
            expiredAt: new Date(expiresAt).toISOString()
          },
          timestamp: new Date().toISOString()
        });
      }

      // Step 2: Check archive exists and get its size via HEAD (no body stream)
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const archiveHead = await bucket.head(r2Key);
      if (!archiveHead) {
        throw new BackupNotFoundError({
          message:
            `Backup archive not found in R2: ${id}. ` +
            'The archive may have been deleted by R2 lifecycle rules.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const archivePath = `${BACKUP_CONTAINER_DIR}/${id}.sqsh`;
      const restoreResult = await this.deps.runBackupAttempt(
        'backup.restore',
        async ({ runtime, control }) => {
          await lifecycle.runtimeReady(runtime, archiveHead.size);
          try {
            const prepareResult = await control.backup.prepareRestore({
              dir,
              backupId: id,
              archivePath
            });

            if (prepareResult.existingSize !== archiveHead.size) {
              await this.transfer.downloadBackupParallel(
                archivePath,
                r2Key,
                archiveHead.size,
                id,
                dir,
                control
              );
            }

            await lifecycle.archiveReady(archiveHead.size);
            return await control.backup.restoreArchive(dir, archivePath);
          } catch (error) {
            await control.backup.cleanupArchive(archivePath).catch(() => {});
            throw error;
          }
        }
      );

      if (!restoreResult.success) {
        throw new BackupRestoreError({
          message: 'Container failed to restore backup archive',
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const result = {
        success: true as const,
        dir,
        id
      };
      await lifecycle.verify(result, archiveHead.size);

      outcome = 'success';

      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'backup.restore',
        outcome,
        durationMs: Date.now() - restoreStartTime,
        backupId: id,
        dir,
        error: caughtError
      });
    }
  }

  /**
   * Local-dev implementation of restoreBackup.
   * Uses the R2 binding directly instead of presigned URLs, and
   * unsquashfs for extraction instead of squashfuse + fuse-overlayfs.
   */
  private async doRestoreBackupLocal(
    backup: DirectoryBackup,
    lifecycle: RestoreLifecycleContext
  ): Promise<BackupRestoreOperationResult> {
    const restoreStartTime = Date.now();
    const { id, dir } = backup;

    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;

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
      // Step 1: Read metadata to check TTL
      const metaKey = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_METADATA_OBJECT_NAME}`;
      const metaObject = await bucket.get(metaKey);
      if (!metaObject) {
        throw new BackupNotFoundError({
          message:
            `Backup not found: ${id}. ` +
            'Verify the backup ID is correct and the backup has not been deleted.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const metadata = await metaObject.json<{
        ttl: number;
        createdAt: string;
        dir: string;
        sizeBytes?: number;
      }>();

      // Check TTL with 60-second buffer
      const TTL_BUFFER_MS = 60 * 1000;
      const createdAt = new Date(metadata.createdAt).getTime();
      if (Number.isNaN(createdAt)) {
        throw new BackupRestoreError({
          message: `Backup metadata has invalid createdAt timestamp: ${metadata.createdAt}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }
      const expiresAt = createdAt + metadata.ttl * 1000;
      if (Date.now() + TTL_BUFFER_MS > expiresAt) {
        throw new BackupExpiredError({
          message:
            `Backup ${id} has expired ` +
            `(created: ${metadata.createdAt}, TTL: ${metadata.ttl}s). ` +
            'Create a new backup.',
          code: ErrorCode.BACKUP_EXPIRED,
          httpStatus: 400,
          context: {
            backupId: id,
            expiredAt: new Date(expiresAt).toISOString()
          },
          timestamp: new Date().toISOString()
        });
      }

      // Step 2: Download archive from R2 via binding and write to container
      const r2Key = `${BACKUP_STORAGE_PREFIX}/${id}/${BACKUP_ARCHIVE_OBJECT_NAME}`;
      const archiveObject = await bucket.get(r2Key);
      if (!archiveObject) {
        throw new BackupNotFoundError({
          message:
            `Backup archive not found in R2: ${id}. ` +
            'The archive may have been deleted by R2 lifecycle rules.',
          code: ErrorCode.BACKUP_NOT_FOUND,
          httpStatus: 404,
          context: { backupId: id },
          timestamp: new Date().toISOString()
        });
      }

      const body = archiveObject.body;
      if (!body) {
        throw new BackupRestoreError({
          message: `R2 archive object has no body stream for backup ${id}`,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          httpStatus: 500,
          context: { dir, backupId: id },
          timestamp: new Date().toISOString()
        });
      }
      const archivePath = `${BACKUP_CONTAINER_DIR}/${id}.sqsh`;

      await this.deps.runBackupAttempt(
        'backup.restore',
        async ({ runtime, control }) => {
          await lifecycle.runtimeReady(runtime, metadata.sizeBytes);
          try {
            await control.backup.prepareRestore({
              dir,
              backupId: id,
              archivePath
            });

            // Stream the archive into the container to avoid base64-encoding the
            // whole archive in Worker memory and hitting workerd's 32 MiB RPC
            // payload cap.
            await control.files.writeFileStream(archivePath, body);

            await lifecycle.archiveReady(metadata.sizeBytes);
            await control.backup.extractArchive(dir, archivePath);

            // Clean up archive after extraction (no FUSE mount holds it open)
            await control.backup.cleanupArchive(archivePath).catch(() => {});
          } catch (error) {
            await control.backup.cleanupArchive(archivePath).catch(() => {});
            throw error;
          }
        }
      );

      const result = {
        success: true as const,
        dir,
        id
      };
      await lifecycle.verify(result, metadata.sizeBytes);

      outcome = 'success';

      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'backup.restore',
        outcome,
        durationMs: Date.now() - restoreStartTime,
        backupId: id,
        dir,
        provider: 'local-binding',
        error: caughtError
      });
    }
  }
}
