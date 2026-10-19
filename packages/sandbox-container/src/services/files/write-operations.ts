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
import { FileReadOperations } from './read-operations';

export class FileWriteOperations extends FileReadOperations {
  async write(
    path: string,
    content: string,
    options: WriteOptions = {}
  ): Promise<ServiceResult<void>> {
    const startTime = Date.now();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let errorMessage: string | undefined;
    const normalizedEncoding =
      options.encoding === 'utf8' ? 'utf-8' : options.encoding || 'utf-8';

    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        errorMessage = `Invalid path format for '${path}': ${validation.errors.join(', ')}`;
        return {
          success: false,
          error: {
            message: errorMessage,
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

      // 2. Write file using Bun native file operations
      if (normalizedEncoding === 'base64') {
        // Validate that content only contains valid base64 characters
        if (!/^[A-Za-z0-9+/=]*$/.test(content)) {
          errorMessage = `Invalid base64 content for '${path}'`;
          return {
            success: false,
            error: {
              message: `Invalid base64 content for '${path}': must contain only A-Z, a-z, 0-9, +, /, =`,
              code: ErrorCode.VALIDATION_FAILED,
              details: {
                validationErrors: [
                  {
                    field: 'content',
                    message: 'Invalid base64 characters',
                    code: 'INVALID_BASE64'
                  }
                ]
              } satisfies ValidationFailedContext
            }
          };
        }
      }

      const writeResult = await this.withExecutionInternal(async (exec) => {
        let targetPath = path;

        if (!path.startsWith('/')) {
          const pwdResult = await exec('pwd');
          if (pwdResult.exitCode !== 0) {
            throw {
              code: ErrorCode.FILESYSTEM_ERROR,
              message: `Failed to resolve working directory for '${path}'`,
              details: {
                path,
                operation: Operation.FILE_WRITE,
                exitCode: pwdResult.exitCode,
                stderr: pwdResult.stderr
              } satisfies FileSystemContext
            };
          }

          const cwd = pwdResult.stdout.trim();
          targetPath = resolve(cwd, path);
        }

        try {
          const data =
            normalizedEncoding === 'base64'
              ? Buffer.from(content, 'base64')
              : content;
          await Bun.write(targetPath, data);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          throw {
            code: ErrorCode.FILESYSTEM_ERROR,
            message: `Failed to write file '${path}': ${errorMessage}`,
            details: {
              path,
              operation: Operation.FILE_WRITE,
              stderr: errorMessage
            } satisfies FileSystemContext
          };
        }
      });

      if (!writeResult.success) {
        outcome = 'error';
        errorMessage = writeResult.error.message;
        return writeResult as ServiceResult<void>;
      }

      outcome = 'success';
      return {
        success: true
      };
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;
      return {
        success: false,
        error: {
          message: `Failed to write file '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.FILE_WRITE,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    } finally {
      const sizeBytes =
        outcome === 'success'
          ? Buffer.byteLength(
              content,
              normalizedEncoding === 'base64' ? 'base64' : 'utf-8'
            )
          : undefined;
      logCanonicalEvent(this.logger, {
        event: 'file.write',
        outcome,
        durationMs: Date.now() - startTime,
        path,
        sizeBytes,
        errorMessage,
        error: caughtError
      });
    }
  }

  async writeFile(
    path: string,
    content: string,
    options?: WriteOptions
  ): Promise<ServiceResult<void>> {
    return await this.write(path, content, options);
  }

  /**
   * Write a file from a ReadableStream.
   * Streams bytes directly to disk without buffering the entire file in memory.
   */
  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>
  ): Promise<ServiceResult<{ bytesWritten: number }>> {
    try {
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

      const writeResult = await this.withExecutionInternal(async (exec) => {
        let targetPath = path;

        if (!path.startsWith('/')) {
          const pwdResult = await exec('pwd');
          if (pwdResult.exitCode !== 0) {
            throw {
              code: ErrorCode.FILESYSTEM_ERROR,
              message: `Failed to resolve working directory for '${path}'`,
              details: {
                path,
                operation: Operation.FILE_WRITE,
                exitCode: pwdResult.exitCode,
                stderr: pwdResult.stderr
              } satisfies FileSystemContext
            };
          }
          const cwd = pwdResult.stdout.trim();
          targetPath = resolve(cwd, path);
        }

        // Ensure parent directory exists
        const dir = targetPath.substring(0, targetPath.lastIndexOf('/'));
        if (dir) {
          await exec(`mkdir -p ${shellEscape(dir)}`);
        }

        // Atomic write: stream to a temporary file, then rename into place.
        // Prevents partial reads if another process opens the file mid-write.
        // Preserves the original file's permission bits (e.g. executables).
        const tmpPath = `${targetPath}.tmp.${crypto.randomUUID()}`;
        const existingMode = await stat(targetPath)
          .then((s) => s.mode)
          .catch(() => null);
        const writer = Bun.file(tmpPath).writer();
        let bytesWritten = 0;
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
            bytesWritten += value.byteLength;
          }
          await writer.flush();
          writer.end();
          reader.releaseLock();
          if (existingMode !== null) {
            await chmod(tmpPath, existingMode);
          }
          await rename(tmpPath, targetPath);
        } catch (err) {
          writer.end();
          reader.releaseLock();
          await stream.cancel().catch(() => {});
          await unlink(tmpPath).catch(() => {});
          throw err;
        }
        return { bytesWritten };
      });

      if (!writeResult.success) {
        return writeResult as ServiceResult<{ bytesWritten: number }>;
      }

      return {
        success: true,
        data: writeResult.data as { bytesWritten: number }
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to stream-write file',
        error instanceof Error ? error : undefined,
        { path }
      );

      return {
        success: false,
        error: {
          message: `Failed to write file '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.FILE_WRITE,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    }
  }
}
