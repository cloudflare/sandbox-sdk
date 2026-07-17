import { logCanonicalEvent, shellEscape } from '@repo/shared';
import type {
  FileNotFoundContext,
  FileSystemContext,
  FileTooLargeContext
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
import type { InternalCommandResult } from '../internal-command-result';
import { pathValidationError } from './path-validation-result';
import { FileWriteOperations } from './write-operations';

export class FileTreeOperations extends FileWriteOperations {
  async delete(path: string): Promise<ServiceResult<void>> {
    const startTime = Date.now();
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
          error: pathValidationError(path, validation.errors)
        };
      }

      const result = await this.withExecutionInternal(async (exec) => {
        const resolvedPath = await this.resolvePathInExecutionContext(
          path,
          exec
        );
        const escapedPath = shellEscape(resolvedPath);

        const existsResult = await exec(`test -e ${escapedPath}`);
        if (existsResult.exitCode !== 0) {
          throw {
            code: ErrorCode.FILE_NOT_FOUND,
            message: `File not found: ${path}`,
            details: {
              path,
              operation: Operation.FILE_DELETE
            } satisfies FileNotFoundContext
          };
        }

        const isDirResult = await exec(`test -d ${escapedPath}`);
        if (isDirResult.exitCode === 0) {
          throw {
            code: ErrorCode.IS_DIRECTORY,
            message: `Cannot delete directory with deleteFile() at '${path}'. Use exec('rm -rf <path>') instead.`,
            details: {
              path,
              operation: Operation.FILE_DELETE
            } satisfies FileSystemContext
          };
        }

        const command = `rm ${escapedPath}`;
        const rmResult = await exec(command);

        if (rmResult.exitCode !== 0) {
          throw {
            code: ErrorCode.FILESYSTEM_ERROR,
            message: `Failed to delete file '${path}': ${
              rmResult.stderr || `exit code ${rmResult.exitCode}`
            }`,
            details: {
              path,
              operation: Operation.FILE_DELETE,
              exitCode: rmResult.exitCode,
              stderr: rmResult.stderr
            } satisfies FileSystemContext
          };
        }
      });

      outcome = result.success ? 'success' : 'error';
      if (!result.success) {
        errorMessage = result.error?.message;
      }
      return result;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
      errorMessage = caughtError.message;
      return {
        success: false,
        error: {
          message: `Failed to delete file '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.FILE_DELETE,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'file.delete',
        outcome,
        durationMs: Date.now() - startTime,
        path,
        errorMessage,
        error: caughtError
      });
    }
  }

  async rename(oldPath: string, newPath: string): Promise<ServiceResult<void>> {
    try {
      // 1. Validate both paths for security
      const oldValidation = this.security.validatePath(oldPath);
      const newValidation = this.security.validatePath(newPath);

      if (!oldValidation.isValid || !newValidation.isValid) {
        const errors = [...oldValidation.errors, ...newValidation.errors];
        return {
          success: false,
          error: {
            message: `Security validation failed: ${errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { oldPath, newPath, errors }
          }
        };
      }

      // 2. Check if source file exists using execution-context check
      const existsResult = await this.exists(oldPath);
      if (!existsResult.success) {
        return existsResult as ServiceResult<void>;
      }

      if (!existsResult.data) {
        return {
          success: false,
          error: {
            message: `Source file not found: ${oldPath}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path: oldPath,
              operation: Operation.FILE_RENAME
            } satisfies FileNotFoundContext
          }
        };
      }

      const execResult =
        await this.withExecutionInternal<InternalCommandResult>(
          async (exec) => {
            const resolvedOldPath = await this.resolvePathInExecutionContext(
              oldPath,
              exec
            );
            const resolvedNewPath = await this.resolvePathInExecutionContext(
              newPath,
              exec
            );
            const command = `mv ${shellEscape(resolvedOldPath)} ${shellEscape(
              resolvedNewPath
            )}`;
            return await exec(command);
          }
        );

      if (!execResult.success) {
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Rename operation failed with exit code ${result.exitCode}`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              oldPath,
              newPath,
              exitCode: result.exitCode,
              stderr: result.stderr
            }
          }
        };
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: `Failed to rename file from '${oldPath}' to '${newPath}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path: oldPath,
            operation: Operation.FILE_RENAME,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    }
  }

  async move(
    sourcePath: string,
    destinationPath: string
  ): Promise<ServiceResult<void>> {
    try {
      // 1. Validate both paths for security
      const sourceValidation = this.security.validatePath(sourcePath);
      const destValidation = this.security.validatePath(destinationPath);

      if (!sourceValidation.isValid || !destValidation.isValid) {
        const errors = [...sourceValidation.errors, ...destValidation.errors];
        return {
          success: false,
          error: {
            message: `Security validation failed: ${errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { sourcePath, destinationPath, errors }
          }
        };
      }

      // 2. Check if source exists using execution-context check
      const existsResult = await this.exists(sourcePath);
      if (!existsResult.success) {
        return existsResult as ServiceResult<void>;
      }

      if (!existsResult.data) {
        return {
          success: false,
          error: {
            message: `Source file not found: ${sourcePath}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path: sourcePath,
              operation: Operation.FILE_MOVE
            } satisfies FileNotFoundContext
          }
        };
      }

      const execResult =
        await this.withExecutionInternal<InternalCommandResult>(
          async (exec) => {
            const resolvedSourcePath = await this.resolvePathInExecutionContext(
              sourcePath,
              exec
            );
            const resolvedDestinationPath =
              await this.resolvePathInExecutionContext(destinationPath, exec);
            const command = `mv ${shellEscape(resolvedSourcePath)} ${shellEscape(
              resolvedDestinationPath
            )}`;
            return await exec(command);
          }
        );

      if (!execResult.success) {
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Move operation failed with exit code ${result.exitCode}`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              sourcePath,
              destinationPath,
              exitCode: result.exitCode,
              stderr: result.stderr
            }
          }
        };
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: `Failed to move file from '${sourcePath}' to '${destinationPath}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path: sourcePath,
            operation: Operation.FILE_MOVE,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    }
  }

  async mkdir(
    path: string,
    options: MkdirOptions = {}
  ): Promise<ServiceResult<void>> {
    const startTime = Date.now();
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
          error: pathValidationError(path, validation.errors)
        };
      }

      // 2. Build mkdir command args (via manager)
      const args = this.manager.buildMkdirArgs(path, options);

      // 3. Build command string from args (skip 'mkdir' at index 0)
      const escapedPath = shellEscape(path);
      let command = 'mkdir';
      if (options.recursive) {
        command += ' -p';
      }
      command += ` ${escapedPath}`;

      // 4. Create directory using the unified execution path
      const execResult = await this.executeInternal(command);

      if (!execResult.success) {
        outcome = 'error';
        errorMessage = execResult.error.message;
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        outcome = 'error';
        errorMessage = `mkdir operation failed with exit code ${result.exitCode}`;
        return {
          success: false,
          error: {
            message: errorMessage,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              options,
              exitCode: result.exitCode,
              stderr: result.stderr
            }
          }
        };
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
          message: `Failed to create directory '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.DIRECTORY_CREATE,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'file.mkdir',
        outcome,
        durationMs: Date.now() - startTime,
        path,
        recursive: options.recursive ?? false,
        errorMessage,
        error: caughtError
      });
    }
  }

  async exists(path: string): Promise<ServiceResult<boolean>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: pathValidationError(path, validation.errors)
        };
      }

      // 2. Check if file/directory exists using the unified execution path
      const escapedPath = shellEscape(path);
      const command = `test -e ${escapedPath}`;

      const execResult = await this.executeInternal(command);

      if (!execResult.success) {
        // If execution fails, treat as non-existent
        return {
          success: true,
          data: false
        };
      }

      // Exit code 0 means file exists, non-zero means it doesn't
      const exists = execResult.data.exitCode === 0;

      return {
        success: true,
        data: exists
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Error checking file existence', {
        path,
        error: errorMessage
      });

      return {
        success: false,
        error: {
          message: `Failed to check file existence for '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.FILE_STAT,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    }
  }
}
