/**
 * Snapshot Service
 *
 * Handles creating and applying directory snapshots to/from R2/S3
 * using SquashFS for instant mounts instead of slow tar extraction.
 *
 * Why SquashFS?
 * - Traditional tar+zstd extraction suffers from ext4 journal contention
 *   when extracting many files (20k+ in node_modules) to a location where
 *   files were recently deleted. This causes 10-30x slowdown (25-50s vs 2-3s).
 * - SquashFS mounts the compressed image directly - no file extraction needed.
 * - Mount is instant (~200ms) regardless of how many times you restore.
 * - SquashFS is read-only, which is ideal for restoring known state.
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

/**
 * Helper to extract error message from session execution result
 */
function getErrorMessage(
  result:
    | { success: false; error: { message: string } }
    | { success: true; data: { stderr?: string } },
  fallback: string
): string {
  if (!result.success) {
    return result.error.message;
  }
  return result.data.stderr || fallback;
}

export class SnapshotService {
  constructor(
    private logger: Logger,
    private sessionManager: SessionManager
  ) {}

  /**
   * Create a snapshot of a directory and upload to R2/S3 via presigned URL
   * Uses mksquashfs with zstd compression for fast mounting on restore.
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
      message: `Creating SquashFS image of ${directory} (${this.formatBytes(totalBytes)})...`,
      timestamp: new Date().toISOString()
    };

    // Create SquashFS image with zstd compression
    const tempFile = `/tmp/snapshot-${Date.now()}.sqsh`;
    const mksquashfsCmd = `mksquashfs ${shellEscape(directory)} ${tempFile} -comp zstd -Xcompression-level ${compressionLevel} -no-progress -quiet 2>&1`;

    const createResult = await this.sessionManager.executeInSession(
      sessionId,
      mksquashfsCmd
    );

    if (!createResult.success) {
      const errorMsg = createResult.error.message;
      this.logger.error('SquashFS creation failed', undefined, {
        directory,
        error: errorMsg
      });
      yield {
        type: 'error',
        operation: 'create',
        message: `Failed to create snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (createResult.data.exitCode !== 0) {
      const errorMsg =
        createResult.data.stderr || 'Failed to create SquashFS image';
      this.logger.error('SquashFS creation failed', undefined, {
        directory,
        error: errorMsg,
        exitCode: createResult.data.exitCode
      });
      yield {
        type: 'error',
        operation: 'create',
        message: `Failed to create snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    yield {
      type: 'progress',
      operation: 'create',
      phase: 'uploading',
      bytesProcessed: 0,
      totalBytes,
      message: 'Uploading snapshot...',
      timestamp: new Date().toISOString()
    };

    // Upload the SquashFS image to R2/S3
    const curlCmd = `curl -sf -X PUT -H "Content-Type: application/octet-stream" -T ${tempFile} ${shellEscape(presignedPutUrl)} -w "%{size_upload}" -o /dev/null && rm -f ${tempFile}`;

    const uploadResult = await this.sessionManager.executeInSession(
      sessionId,
      curlCmd
    );

    if (!uploadResult.success) {
      const errorMsg = uploadResult.error.message;
      this.logger.error('Snapshot upload failed', undefined, {
        directory,
        error: errorMsg
      });
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -f ${tempFile}`
      );
      yield {
        type: 'error',
        operation: 'create',
        message: `Failed to upload snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (uploadResult.data.exitCode !== 0) {
      const errorMsg = uploadResult.data.stderr || 'Upload failed';
      this.logger.error('Snapshot upload failed', undefined, {
        directory,
        error: errorMsg,
        exitCode: uploadResult.data.exitCode
      });
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -f ${tempFile}`
      );
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
    const uploadedBytes = parseInt(uploadResult.data.stdout?.trim() || '0', 10);

    const durationMs = Date.now() - startTime;
    this.logger.info('Snapshot creation complete', {
      directory,
      uploadedBytes,
      durationMs,
      format: 'squashfs'
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
   * Uses squashfuse to mount the image directly - no extraction needed.
   *
   * The mounted filesystem is read-only (SquashFS limitation), which is
   * appropriate for restoring a known state. If writes are needed, the
   * caller should copy files to a writable location.
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

    // Unmount if already mounted (idempotent restore)
    await this.sessionManager.executeInSession(
      sessionId,
      `fusermount -u ${shellEscape(targetDirectory)} 2>/dev/null || true`
    );

    // Clear and recreate mount point (squashfuse requires empty directory)
    // We remove and recreate to ensure clean state
    const mkdirResult = await this.sessionManager.executeInSession(
      sessionId,
      `rm -rf ${shellEscape(targetDirectory)} && mkdir -p ${shellEscape(targetDirectory)}`
    );

    if (!mkdirResult.success) {
      this.logger.error('Failed to create mount point', undefined, {
        targetDirectory,
        error: mkdirResult.error.message
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to create mount point: ${mkdirResult.error.message}`,
        code: ErrorCode.FILESYSTEM_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (mkdirResult.data.exitCode !== 0) {
      this.logger.error('Failed to create mount point', undefined, {
        targetDirectory,
        error: mkdirResult.data.stderr
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to create mount point: ${mkdirResult.data.stderr || 'Unknown error'}`,
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
      message: 'Downloading snapshot...',
      timestamp: new Date().toISOString()
    };

    // Download SquashFS image to a persistent location
    const snapshotDir = '/var/snapshots';
    const snapshotFile = `${snapshotDir}/snapshot-${Date.now()}.sqsh`;

    // Ensure snapshot storage directory exists
    await this.sessionManager.executeInSession(
      sessionId,
      `mkdir -p ${snapshotDir}`
    );

    // Download the SquashFS image
    const downloadCmd = `curl -sf -o ${snapshotFile} ${shellEscape(presignedGetUrl)}`;
    const downloadResult = await this.sessionManager.executeInSession(
      sessionId,
      downloadCmd
    );

    if (!downloadResult.success) {
      this.logger.error('Snapshot download failed', undefined, {
        targetDirectory,
        error: downloadResult.error.message
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to download snapshot: ${downloadResult.error.message}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (downloadResult.data.exitCode !== 0) {
      const errorMsg = downloadResult.data.stderr || 'Download failed';
      this.logger.error('Snapshot download failed', undefined, {
        targetDirectory,
        error: errorMsg
      });
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to download snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    yield {
      type: 'progress',
      operation: 'apply',
      phase: 'mounting',
      bytesProcessed: 0,
      message: `Mounting snapshot at ${targetDirectory}...`,
      timestamp: new Date().toISOString()
    };

    // Mount the SquashFS image using squashfuse
    // This is instant (~200ms) regardless of file count!
    const mountCmd = `squashfuse ${snapshotFile} ${shellEscape(targetDirectory)}`;
    const mountResult = await this.sessionManager.executeInSession(
      sessionId,
      mountCmd
    );

    if (!mountResult.success) {
      this.logger.error('Snapshot mount failed', undefined, {
        targetDirectory,
        error: mountResult.error.message
      });
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -f ${snapshotFile}`
      );
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to mount snapshot: ${mountResult.error.message}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    if (mountResult.data.exitCode !== 0) {
      const errorMsg = mountResult.data.stderr || 'Mount failed';
      this.logger.error('Snapshot mount failed', undefined, {
        targetDirectory,
        error: errorMsg
      });
      await this.sessionManager.executeInSession(
        sessionId,
        `rm -f ${snapshotFile}`
      );
      yield {
        type: 'error',
        operation: 'apply',
        message: `Failed to mount snapshot: ${errorMsg}`,
        code: ErrorCode.UNKNOWN_ERROR,
        timestamp: new Date().toISOString()
      };
      return;
    }

    // Clean up old snapshot files (keep only the current one)
    await this.sessionManager.executeInSession(
      sessionId,
      `find ${snapshotDir} -name "*.sqsh" ! -name "$(basename ${snapshotFile})" -delete 2>/dev/null || true`
    );

    const durationMs = Date.now() - startTime;
    this.logger.info('Snapshot apply complete', {
      targetDirectory,
      durationMs,
      format: 'squashfs',
      mountPoint: targetDirectory,
      snapshotFile
    });

    yield {
      type: 'complete',
      operation: 'apply',
      sizeBytes: 0,
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
