import { chmod, rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FileInfo, ListFilesOptions, Logger } from '@repo/shared';
import { logCanonicalEvent, shellEscape } from '@repo/shared';
import type {
  FileNotFoundContext,
  FileSystemContext,
  FileTooLargeContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode, Operation } from '@repo/shared/errors';
import {
  type FileMetadata,
  type FileStats,
  type MkdirOptions,
  type ReadOptions,
  type ServiceError,
  type ServiceResult,
  serviceError,
  serviceSuccess,
  type WriteOptions
} from '../../core/types';
import { FileOperationBase, MAX_ENCODED_FILE_SIZE } from './base';

export class FileReadOperations extends FileOperationBase {
  async read(
    path: string,
    options: ReadOptions = {}
  ): Promise<ServiceResult<string, FileMetadata>> {
    const startTime = Date.now();
    let sizeBytes: number | undefined;
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;

    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        errorMessage = `Invalid path format for '${path}': ${validation.errors.join(', ')}`;
        return {
          success: false,
          error: {
            message: `Invalid path format for '${path}': ${validation.errors.join(
              ', '
            )}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: validation.errors.map((e) => ({
                field: 'path',
                message: e,
                code: 'INVALID_PATH'
              }))
            } satisfies ValidationFailedContext
          }
        };
      }

      const result = await this.withExecutionInternal(async (exec) => {
        const absolutePath = await this.resolvePathInExecutionContext(
          path,
          exec
        );

        const bunFile = Bun.file(absolutePath);

        const fileExists = await bunFile.exists();
        if (!fileExists) {
          throw {
            message: `File not found: ${path}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path,
              operation: Operation.FILE_READ
            } satisfies FileNotFoundContext
          };
        }

        // Size and MIME type come directly from the BunFile object.
        const fileSize = bunFile.size;
        // Encoded responses have a hard limit of 32 MiB. Larger files should use readFile() with { encoding: 'none' }.
        if (fileSize > MAX_ENCODED_FILE_SIZE) {
          throw {
            message: `File too large. Size ${fileSize} bytes exceeds the 32 MiB limit. Use readFile() with { encoding: 'none' } for large files.`,
            code: ErrorCode.FILE_TOO_LARGE,
            details: {
              path,
              operation: Operation.FILE_READ,
              actualSize: fileSize,
              maxSize: MAX_ENCODED_FILE_SIZE
            } satisfies FileTooLargeContext
          };
        }

        // Bun.file() derives the MIME type from the file extension and falls back
        // to 'application/octet-stream' for unknown types.
        let mimeType = bunFile.type.split(';')[0].trim();
        if (mimeType === 'application/octet-stream') {
          const escapedPath = shellEscape(path);
          const mimeResult = await exec(`file --mime-type -b ${escapedPath}`);
          if (mimeResult.exitCode === 0) {
            mimeType = mimeResult.stdout.trim();
          }
        }

        const isBinary = this.isBinaryMimeType(mimeType);

        // Determine encoding: honour explicit caller preference, otherwise fall
        // back to MIME-based detection.
        let actualEncoding: 'utf-8' | 'base64';
        if (options.encoding === 'base64') {
          actualEncoding = 'base64';
        } else if (
          options.encoding === 'utf-8' ||
          options.encoding === 'utf8'
        ) {
          actualEncoding = 'utf-8';
        } else {
          actualEncoding = isBinary ? 'base64' : 'utf-8';
        }

        // 3. Read file content natively.
        let content: string;
        if (actualEncoding === 'base64') {
          const buffer = await bunFile.arrayBuffer();
          content = Buffer.from(buffer).toString('base64');
        } else {
          content = await bunFile.text();
        }

        sizeBytes = fileSize;

        return {
          success: true as const,
          content,
          metadata: {
            encoding: actualEncoding,
            isBinary: actualEncoding === 'base64',
            mimeType,
            size: fileSize
          }
        };
      }).then((r) => {
        if (!r.success) {
          return r as ServiceResult<string, FileMetadata>;
        }

        return {
          success: true as const,
          data: r.data.content,
          metadata: r.data.metadata
        };
      });

      outcome = result.success ? 'success' : 'error';
      if (!result.success) {
        errorMessage = result.error.message;
      }
      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;
      return {
        success: false,
        error: {
          message: `Failed to read file '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.FILE_READ,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'file.read',
        outcome,
        durationMs: Date.now() - startTime,
        path,
        sizeBytes,
        errorMessage,
        error: caughtError
      });
    }
  }

  async getFileMetadata(
    path: string,
    exec: (
      command: string,
      options?: {
        cwd?: string;
        env?: Record<string, string | undefined>;
      }
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  ): Promise<ServiceResult<FileMetadata>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid path format for '${path}': ${validation.errors.join(', ')}`,
            code: ErrorCode.VALIDATION_FAILED,
            details: {
              validationErrors: validation.errors.map((e) => ({
                field: 'path',
                message: e,
                code: 'INVALID_PATH'
              }))
            } satisfies ValidationFailedContext
          }
        };
      }
      // 2. Use Bun.file() for existence and stat.
      const bunFile = Bun.file(path);
      const fileExists = await bunFile.exists();

      if (!fileExists) {
        return {
          success: false,
          error: {
            message: `File not found: ${path}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path,
              operation: Operation.FILE_READ
            } satisfies FileNotFoundContext
          }
        };
      }

      const fileSize = bunFile.size;

      // 3. Determine MIME type.  Bun derives this from the file extension; for
      //    unknown extensions it returns 'application/octet-stream'.  In that
      //    case we run `file --mime-type` as a fallback so we can correctly
      //    classify extension-less binaries (e.g. compiled executables).
      let mimeType = bunFile.type.split(';')[0].trim();
      if (mimeType === 'application/octet-stream') {
        const escapedPath = shellEscape(path);
        const mimeResult = await exec(`file --mime-type -b ${escapedPath}`);
        if (mimeResult.exitCode === 0) {
          mimeType = mimeResult.stdout.trim();
        }
        // If the fallback fails we keep 'application/octet-stream', which
        // isBinaryMimeType() will correctly classify as binary.
      }

      // 4. Classify binary vs text
      const isBinary = this.isBinaryMimeType(mimeType);

      return {
        success: true,
        data: {
          mimeType,
          size: fileSize,
          isBinary,
          encoding: isBinary ? 'base64' : 'utf-8'
        }
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: `Failed to get file metadata for '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.FILE_READ,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    }
  }

  // Convenience methods with ServiceResult wrapper for higher-level operations

  async readFile(
    path: string,
    options?: ReadOptions
  ): Promise<ServiceResult<string, FileMetadata>> {
    return await this.read(path, options);
  }
}
