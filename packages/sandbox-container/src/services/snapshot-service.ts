/**
 * Snapshot Service
 *
 * Handles creating and applying directory snapshots to/from R2/S3
 * using tar + zstd compression with streaming progress feedback.
 */

import type {
  ApplySnapshotRequest,
  CreateSnapshotRequest,
  Logger,
  SnapshotEvent
} from '@repo/shared';
import { shellEscape } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { SessionManager } from './session-manager';

export class SnapshotService {
  constructor(
    private logger: Logger,
    private sessionManager: SessionManager
  ) {}

  /**
   * Create a snapshot of a directory and upload to R2/S3 via presigned URL
   * Yields progress events for monitoring
   */
  async *createSnapshot(
    request: CreateSnapshotRequest
  ): AsyncGenerator<SnapshotEvent> {
    const startTime = Date.now();
    const {
      directory,
      presignedPutUrl,
      compressionLevel = 3,
      sessionId = 'default'
    } = request;

    this.logger.info('Starting snapshot creation', { directory, sessionId });

    yield {
      type: 'start',
      operation: 'create',
      directory,
      timestamp: new Date().toISOString()
    };

    // Validate directory exists
    const checkResult = await this.sessionManager.executeInSession(
      sessionId,
      `test -d ${shellEscape(directory)} && echo "exists" || echo "not_found"`
    );

    if (!checkResult.success || !checkResult.data?.stdout?.includes('exists')) {
      this.logger.error('Directory not found for snapshot', undefined, {
        directory
      });
      yield {
        type: 'error',
        operation: 'create',
        message: `Directory does not exist: ${directory}`,
        code: ErrorCode.FILE_NOT_FOUND,
        timestamp: new Date().toISOString()
      };
      return;
    }

    // Get directory size for progress reporting
    yield {
      type: 'progress',
      operation: 'create',
      phase: 'scanning',
      bytesProcessed: 0,
      message: 'Calculating directory size...',
      timestamp: new Date().toISOString()
    };

    const sizeResult = await this.sessionManager.executeInSession(
      sessionId,
      `du -sb ${shellEscape(directory)} 2>/dev/null | cut -f1`
    );
    const totalBytes =
      sizeResult.success && sizeResult.data
        ? parseInt(sizeResult.data.stdout?.trim() || '0', 10)
        : 0;

    this.logger.debug('Directory size calculated', {
      directory,
      totalBytes
    });

    yield {
      type: 'progress',
      operation: 'create',
      phase: 'compressing',
      bytesProcessed: 0,
      totalBytes,
      percent: 0,
      message: `Compressing ${directory} (${this.formatBytes(totalBytes)})...`,
      timestamp: new Date().toISOString()
    };

    // Build the command:
    // 1. tar creates archive from directory
    // 2. zstd compresses with specified level (-T0 uses all cores)
    // 3. curl uploads to presigned URL
    //
    // We use curl's --write-out to capture the uploaded size
    // The -f flag makes curl fail on HTTP errors
    const tarZstdCmd = `tar -cf - -C ${shellEscape(directory)} .`;
    const zstdCmd = `zstd -${compressionLevel} -T0`;
    const curlCmd = `curl -sf -X PUT -H "Content-Type: application/octet-stream" --data-binary @- ${shellEscape(presignedPutUrl)} -w "%{size_upload}" -o /dev/null`;
    const fullCommand = `${tarZstdCmd} | ${zstdCmd} | ${curlCmd}`;

    yield {
      type: 'progress',
      operation: 'create',
      phase: 'uploading',
      bytesProcessed: 0,
      totalBytes,
      message: 'Uploading snapshot...',
      timestamp: new Date().toISOString()
    };

    // Execute the upload
    const uploadResult = await this.sessionManager.executeInSession(
      sessionId,
      fullCommand
    );

    if (!uploadResult.success) {
      const errorMsg = uploadResult.error?.message || 'Upload failed';
      this.logger.error('Snapshot upload failed', undefined, {
        directory,
        error: errorMsg
      });
      yield {
        type: 'error',
        operation: 'create',
        message: `Failed to upload snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (uploadResult.data?.exitCode !== 0) {
      const errorMsg = uploadResult.data?.stderr || 'Upload failed';
      this.logger.error('Snapshot upload failed', undefined, {
        directory,
        error: errorMsg,
        exitCode: uploadResult.data?.exitCode
      });
      yield {
        type: 'error',
        operation: 'create',
        message: `Failed to upload snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    // Parse the uploaded bytes from stdout (curl's write-out)
    const uploadedBytes = parseInt(
      uploadResult.data?.stdout?.trim() || '0',
      10
    );

    const durationMs = Date.now() - startTime;
    this.logger.info('Snapshot creation complete', {
      directory,
      uploadedBytes,
      durationMs
    });

    yield {
      type: 'complete',
      operation: 'create',
      sizeBytes: uploadedBytes,
      durationMs,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Download and apply a snapshot from R2/S3 via presigned URL
   * Yields progress events for monitoring
   */
  async *applySnapshot(
    request: ApplySnapshotRequest
  ): AsyncGenerator<SnapshotEvent> {
    const startTime = Date.now();
    const { presignedGetUrl, targetDirectory, sessionId = 'default' } = request;

    this.logger.info('Starting snapshot apply', { targetDirectory, sessionId });

    yield {
      type: 'start',
      operation: 'apply',
      directory: targetDirectory,
      timestamp: new Date().toISOString()
    };

    // Ensure target directory exists
    const mkdirResult = await this.sessionManager.executeInSession(
      sessionId,
      `mkdir -p ${shellEscape(targetDirectory)}`
    );

    if (!mkdirResult.success) {
      this.logger.error('Failed to create target directory', undefined, {
        targetDirectory,
        error: mkdirResult.error?.message
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to create target directory: ${mkdirResult.error?.message || 'Unknown error'}`,
        code: ErrorCode.FILESYSTEM_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (mkdirResult.data?.exitCode !== 0) {
      this.logger.error('Failed to create target directory', undefined, {
        targetDirectory,
        error: mkdirResult.data?.stderr
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to create target directory: ${mkdirResult.data?.stderr || 'Unknown error'}`,
        code: ErrorCode.FILESYSTEM_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    yield {
      type: 'progress',
      operation: 'apply',
      phase: 'downloading',
      bytesProcessed: 0,
      message: `Downloading and extracting to ${targetDirectory}...`,
      timestamp: new Date().toISOString()
    };

    // Stream download through zstd decompression and tar extraction
    // curl -f fails on HTTP errors, streams to stdout
    // zstd -d decompresses
    // tar -x extracts to target directory
    const extractCmd = `curl -sf ${shellEscape(presignedGetUrl)} | zstd -d | tar -xf - -C ${shellEscape(targetDirectory)}`;

    const result = await this.sessionManager.executeInSession(
      sessionId,
      extractCmd
    );

    if (!result.success) {
      const errorMsg = result.error?.message || 'Extraction failed';
      this.logger.error('Snapshot apply failed', undefined, {
        targetDirectory,
        error: errorMsg
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to apply snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (result.data?.exitCode !== 0) {
      const errorMsg = result.data?.stderr || 'Extraction failed';
      this.logger.error('Snapshot apply failed', undefined, {
        targetDirectory,
        error: errorMsg,
        exitCode: result.data?.exitCode
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to apply snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    yield {
      type: 'progress',
      operation: 'apply',
      phase: 'extracting',
      bytesProcessed: 0,
      message: 'Calculating extracted size...',
      timestamp: new Date().toISOString()
    };

    // Get extracted size
    const sizeResult = await this.sessionManager.executeInSession(
      sessionId,
      `du -sb ${shellEscape(targetDirectory)} 2>/dev/null | cut -f1`
    );
    const extractedBytes =
      sizeResult.success && sizeResult.data
        ? parseInt(sizeResult.data.stdout?.trim() || '0', 10)
        : 0;

    const durationMs = Date.now() - startTime;
    this.logger.info('Snapshot apply complete', {
      targetDirectory,
      extractedBytes,
      durationMs
    });

    yield {
      type: 'complete',
      operation: 'apply',
      sizeBytes: extractedBytes,
      durationMs,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Format bytes into human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
  }
}
