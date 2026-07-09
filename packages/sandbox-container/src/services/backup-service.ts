import type { Logger } from '@repo/shared';
import type { ServiceResult } from '../core/types';
import {
  ArchiveOperations,
  type BackupCreateCompressionOptions,
  type BackupUploadPart,
  type CreateArchiveResult,
  type RestoreArchiveResult,
  type UploadedBackupPart
} from './backup/archive-operations';
import { RestoreOperations } from './backup/restore-operations';
import { TransferOperations } from './backup/transfer-operations';
import type { CommandContextService } from './command-context-service';

export { BACKUP_WORK_DIR } from './backup/archive-operations';

export class BackupService {
  private archiveOperations: ArchiveOperations;
  private restoreOperations: RestoreOperations;
  private transferOperations: TransferOperations;

  constructor(logger: Logger, commandContextService: CommandContextService) {
    this.archiveOperations = new ArchiveOperations(
      logger,
      commandContextService
    );
    this.restoreOperations = new RestoreOperations(
      logger,
      commandContextService
    );
    this.transferOperations = new TransferOperations(
      logger,
      commandContextService
    );
  }

  async createArchive(
    dir: string,
    archivePath: string,
    gitignore = false,
    excludes: string[] = [],
    compression?: BackupCreateCompressionOptions
  ): Promise<ServiceResult<CreateArchiveResult>> {
    return this.archiveOperations.createArchive(
      dir,
      archivePath,
      gitignore,
      excludes,
      compression
    );
  }

  async restoreArchive(
    dir: string,
    archivePath: string
  ): Promise<ServiceResult<RestoreArchiveResult>> {
    return this.restoreOperations.restoreArchive(dir, archivePath);
  }

  async uploadArchive(request: {
    archivePath: string;
    url: string;
    timeoutMs: number;
  }): Promise<ServiceResult<void>> {
    return this.transferOperations.uploadArchive(request);
  }

  async uploadParts(
    archivePath: string,
    parts: BackupUploadPart[]
  ): Promise<ServiceResult<{ parts: UploadedBackupPart[] }>> {
    return this.transferOperations.uploadParts(archivePath, parts);
  }

  async prepareRestore(request: {
    dir: string;
    backupId: string;
    archivePath: string;
  }): Promise<ServiceResult<{ existingSize: number }>> {
    return this.restoreOperations.prepareRestore(request);
  }

  async downloadArchive(request: {
    archivePath: string;
    expectedSize: number;
    parts: Array<{ url: string; offset: number; range?: string }>;
    timeoutMs: number;
  }): Promise<ServiceResult<void>> {
    return this.transferOperations.downloadArchive(request);
  }

  async extractArchive(
    dir: string,
    archivePath: string
  ): Promise<ServiceResult<void>> {
    return this.restoreOperations.extractArchive(dir, archivePath);
  }

  async cleanupArchive(archivePath: string): Promise<ServiceResult<void>> {
    return this.transferOperations.cleanupArchive(archivePath);
  }

  static normalizeMksquashfsPattern(pattern: string): string | null {
    return ArchiveOperations.normalizeMksquashfsPattern(pattern);
  }
}
