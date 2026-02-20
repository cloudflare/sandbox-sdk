import type {
  CreateBackupRequest,
  CreateBackupResponse,
  Logger,
  RestoreBackupRequest,
  RestoreBackupResponse
} from '@repo/shared';
import { ErrorCode, Operation } from '@repo/shared/errors';

import type { RequestContext } from '../core/types';
import type { BackupService } from '../services/backup-service';
import { BACKUP_WORK_DIR } from '../services/backup-service';
import { BaseHandler } from './base-handler';

export class BackupHandler extends BaseHandler<Request, Response> {
  constructor(
    private backupService: BackupService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/backup/create':
        return await this.handleCreate(request, context);
      case '/api/backup/restore':
        return await this.handleRestore(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid backup endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  /** Maximum path length (matches Linux PATH_MAX) to prevent DoS via oversized strings */
  private static readonly MAX_PATH_LENGTH = 4096;

  /**
   * Validate directory path for safety (defense-in-depth).
   * Returns error message if invalid, undefined if valid.
   */
  private static validateDirPath(dir: string): string | undefined {
    if (!dir || typeof dir !== 'string') {
      return 'Missing or invalid field: dir';
    }
    if (dir.length > BackupHandler.MAX_PATH_LENGTH) {
      return 'dir path exceeds maximum length';
    }
    if (!dir.startsWith('/')) {
      return 'dir must be an absolute path';
    }
    if (dir.includes('..')) {
      return 'dir must not contain path traversal sequences';
    }
    if (dir.includes('\0')) {
      return 'dir must not contain null bytes';
    }
    return undefined;
  }

  /**
   * Validate archive path for safety.
   * Archives must be in the designated backup directory and contain no traversal.
   */
  private static validateArchivePath(archivePath: string): string | undefined {
    if (!archivePath || typeof archivePath !== 'string') {
      return 'Missing or invalid field: archivePath';
    }
    if (archivePath.length > BackupHandler.MAX_PATH_LENGTH) {
      return 'archivePath exceeds maximum length';
    }
    if (archivePath.includes('..')) {
      return 'archivePath must not contain path traversal sequences';
    }
    if (!archivePath.startsWith(`${BACKUP_WORK_DIR}/`)) {
      return 'Invalid archivePath: must use designated backup directory';
    }
    return undefined;
  }

  private async handleCreate(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<CreateBackupRequest>(request);

    const dirError = BackupHandler.validateDirPath(body.dir);
    if (dirError) {
      return this.createErrorResponse(
        {
          message: dirError,
          code: ErrorCode.INVALID_BACKUP_CONFIG
        },
        context,
        Operation.BACKUP_CREATE
      );
    }
    const archiveError = BackupHandler.validateArchivePath(body.archivePath);
    if (archiveError) {
      return this.createErrorResponse(
        {
          message: archiveError,
          code: ErrorCode.INVALID_BACKUP_CONFIG
        },
        context,
        Operation.BACKUP_CREATE
      );
    }

    const sessionId = body.sessionId ?? context.sessionId ?? 'default';

    const result = await this.backupService.createArchive(
      body.dir,
      body.archivePath,
      sessionId
    );

    if (result.success) {
      const response: CreateBackupResponse = {
        success: true,
        sizeBytes: result.data.sizeBytes,
        archivePath: result.data.archivePath
      };
      return this.createTypedResponse(response, context);
    }

    return this.createErrorResponse(
      result.error,
      context,
      Operation.BACKUP_CREATE
    );
  }

  private async handleRestore(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<RestoreBackupRequest>(request);

    const dirError = BackupHandler.validateDirPath(body.dir);
    if (dirError) {
      return this.createErrorResponse(
        {
          message: dirError,
          code: ErrorCode.INVALID_BACKUP_CONFIG
        },
        context,
        Operation.BACKUP_RESTORE
      );
    }
    const archiveError = BackupHandler.validateArchivePath(body.archivePath);
    if (archiveError) {
      return this.createErrorResponse(
        {
          message: archiveError,
          code: ErrorCode.INVALID_BACKUP_CONFIG
        },
        context,
        Operation.BACKUP_RESTORE
      );
    }

    const sessionId = body.sessionId ?? context.sessionId ?? 'default';

    const result = await this.backupService.restoreArchive(
      body.dir,
      body.archivePath,
      sessionId
    );

    if (result.success) {
      const response: RestoreBackupResponse = {
        success: true,
        dir: result.data.dir
      };
      return this.createTypedResponse(response, context);
    }

    return this.createErrorResponse(
      result.error,
      context,
      Operation.BACKUP_RESTORE
    );
  }
}
