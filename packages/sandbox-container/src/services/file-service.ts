import type { FileInfo, ListFilesOptions, Logger } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import type {
  FileNotFoundContext,
  FileSystemContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode, Operation } from '@repo/shared/errors';
import type {
  FileMetadata,
  FileStats,
  MkdirOptions,
  ReadOptions,
  ServiceResult,
  WriteOptions
} from '../core/types';
import { FileManager } from '../managers/file-manager';
import type { SessionManager } from './session-manager';

export interface SecurityService {
  validatePath(path: string): { isValid: boolean; errors: string[] };
}

// File system operations interface with session support
export interface FileSystemOperations {
  read(
    path: string,
    options?: ReadOptions,
    sessionId?: string
  ): Promise<ServiceResult<string, FileMetadata>>;
  write(
    path: string,
    content: string,
    options?: WriteOptions,
    sessionId?: string
  ): Promise<ServiceResult<void>>;
  delete(path: string, sessionId?: string): Promise<ServiceResult<void>>;
  rename(
    oldPath: string,
    newPath: string,
    sessionId?: string
  ): Promise<ServiceResult<void>>;
  move(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ): Promise<ServiceResult<void>>;
  mkdir(
    path: string,
    options?: MkdirOptions,
    sessionId?: string
  ): Promise<ServiceResult<void>>;
  exists(path: string, sessionId?: string): Promise<ServiceResult<boolean>>;
  stat(path: string, sessionId?: string): Promise<ServiceResult<FileStats>>;
  list(
    path: string,
    options?: ListFilesOptions,
    sessionId?: string
  ): Promise<ServiceResult<FileInfo[]>>;
}

export class FileService implements FileSystemOperations {
  private manager: FileManager;

  constructor(
    private security: SecurityService,
    private logger: Logger,
    private sessionManager: SessionManager
  ) {
    this.manager = new FileManager();
  }

  async read(
    path: string,
    options: ReadOptions = {},
    sessionId = 'default'
  ): Promise<ServiceResult<string, FileMetadata>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Check if file exists using session-aware check
      const existsResult = await this.exists(path, sessionId);
      if (!existsResult.success) {
        return {
          success: false,
          error: existsResult.error
        };
      }

      if (!existsResult.data) {
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

      // 3. Get file size using stat
      const escapedPath = shellEscape(path);
      const statCommand = `stat -c '%s' ${escapedPath} 2>/dev/null`;
      const statResult = await this.sessionManager.executeInSession(
        sessionId,
        statCommand
      );

      if (!statResult.success) {
        return {
          success: false,
          error: {
            message: `Failed to get file size for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: 'Command execution failed'
            } satisfies FileSystemContext
          }
        };
      }

      if (statResult.data.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to get file size for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: statResult.data.stderr
            } satisfies FileSystemContext
          }
        };
      }

      const fileSize = parseInt(statResult.data.stdout.trim(), 10);

      // 4. Detect MIME type using file command
      const mimeCommand = `file --mime-type -b ${escapedPath}`;
      const mimeResult = await this.sessionManager.executeInSession(
        sessionId,
        mimeCommand
      );

      if (!mimeResult.success) {
        return {
          success: false,
          error: {
            message: `Failed to detect MIME type for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: 'Command execution failed'
            } satisfies FileSystemContext
          }
        };
      }

      if (mimeResult.data.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to detect MIME type for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: mimeResult.data.stderr
            } satisfies FileSystemContext
          }
        };
      }

      const mimeType = mimeResult.data.stdout.trim();

      // 5. Determine if file is binary based on MIME type
      // Text MIME types: text/*, application/json, application/xml, application/javascript, etc.
      const isBinary =
        !mimeType.startsWith('text/') &&
        !mimeType.includes('json') &&
        !mimeType.includes('xml') &&
        !mimeType.includes('javascript') &&
        !mimeType.includes('x-empty');

      // 6. Read file with appropriate encoding
      // Respect user's encoding preference if provided, otherwise use MIME-based detection
      let actualEncoding: 'utf-8' | 'base64';
      if (options.encoding === 'base64') {
        actualEncoding = 'base64';
      } else if (options.encoding === 'utf-8' || options.encoding === 'utf8') {
        actualEncoding = 'utf-8';
      } else {
        // No explicit encoding requested - use MIME-based detection (original behavior)
        actualEncoding = isBinary ? 'base64' : 'utf-8';
      }

      let content: string;
      if (actualEncoding === 'base64') {
        // Binary files: read as base64, return as-is (DO NOT decode)
        const base64Command = `base64 -w 0 < ${escapedPath}`;
        const base64Result = await this.sessionManager.executeInSession(
          sessionId,
          base64Command
        );

        if (!base64Result.success) {
          return {
            success: false,
            error: {
              message: `Failed to read binary file '${path}': Command execution failed`,
              code: ErrorCode.FILESYSTEM_ERROR,
              details: {
                path,
                operation: Operation.FILE_READ
              } satisfies FileSystemContext
            }
          };
        }

        if (base64Result.data.exitCode !== 0) {
          return {
            success: false,
            error: {
              message: `Failed to read binary file '${path}': ${base64Result.data.stderr}`,
              code: ErrorCode.FILESYSTEM_ERROR,
              details: {
                path,
                operation: Operation.FILE_READ,
                exitCode: base64Result.data.exitCode,
                stderr: base64Result.data.stderr
              } satisfies FileSystemContext
            }
          };
        }

        content = base64Result.data.stdout.trim();
      } else {
        // Text files: read normally
        const catCommand = `cat ${escapedPath}`;
        const catResult = await this.sessionManager.executeInSession(
          sessionId,
          catCommand
        );

        if (!catResult.success) {
          return {
            success: false,
            error: {
              message: `Failed to read text file '${path}': Command execution failed`,
              code: ErrorCode.FILESYSTEM_ERROR,
              details: {
                path,
                operation: Operation.FILE_READ
              } satisfies FileSystemContext
            }
          };
        }

        if (catResult.data.exitCode !== 0) {
          return {
            success: false,
            error: {
              message: `Failed to read text file '${path}': ${catResult.data.stderr}`,
              code: ErrorCode.FILESYSTEM_ERROR,
              details: {
                path,
                operation: Operation.FILE_READ,
                exitCode: catResult.data.exitCode,
                stderr: catResult.data.stderr
              } satisfies FileSystemContext
            }
          };
        }

        content = catResult.data.stdout;
      }

      return {
        success: true,
        data: content,
        metadata: {
          encoding: actualEncoding,
          isBinary: actualEncoding === 'base64',
          mimeType,
          size: fileSize
        }
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to read file',
        error instanceof Error ? error : undefined,
        { path }
      );

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
    }
  }

  async write(
    path: string,
    content: string,
    options: WriteOptions = {},
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Write file using SessionManager with proper encoding handling
      const escapedPath = shellEscape(path);
      const encoding = options.encoding || 'utf-8';

      let command: string;

      if (encoding === 'base64') {
        // Content is already base64 encoded, validate and decode it directly to file
        // Validate that content only contains valid base64 characters to prevent command injection
        if (!/^[A-Za-z0-9+/=]*$/.test(content)) {
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
        // Use printf to output base64 literally without trailing newline
        command = `printf '%s' '${content}' | base64 -d > ${escapedPath}`;
      } else {
        // Encode text to base64 to safely handle shell metacharacters (quotes, backticks, $, etc.)
        // and special characters (newlines, control chars, null bytes) in user content
        const base64Content = Buffer.from(content, 'utf-8').toString('base64');
        command = `printf '%s' '${base64Content}' | base64 -d > ${escapedPath}`;
      }

      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
      );

      if (!execResult.success) {
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to write file '${path}': ${
              result.stderr || `exit code ${result.exitCode}`
            }`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_WRITE,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies FileSystemContext
          }
        };
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to write file',
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

  async delete(
    path: string,
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Check if file exists using session-aware check
      const existsResult = await this.exists(path, sessionId);
      if (!existsResult.success) {
        return existsResult as ServiceResult<void>;
      }

      if (!existsResult.data) {
        return {
          success: false,
          error: {
            message: `File not found: ${path}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path,
              operation: Operation.FILE_DELETE
            } satisfies FileNotFoundContext
          }
        };
      }

      // 3. Check if path is a directory (deleteFile only works on files)
      const statResult = await this.stat(path, sessionId);
      if (statResult.success && statResult.data.isDirectory) {
        return {
          success: false,
          error: {
            message: `Cannot delete directory with deleteFile() at '${path}'. Use exec('rm -rf <path>') instead.`,
            code: ErrorCode.IS_DIRECTORY,
            details: {
              path,
              operation: Operation.FILE_DELETE
            } satisfies FileSystemContext
          }
        };
      }

      // 4. Delete file using SessionManager with rm command
      const escapedPath = shellEscape(path);
      const command = `rm ${escapedPath}`;

      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
      );

      if (!execResult.success) {
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to delete file '${path}': ${
              result.stderr || `exit code ${result.exitCode}`
            }`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_DELETE,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies FileSystemContext
          }
        };
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to delete file',
        error instanceof Error ? error : undefined,
        { path }
      );

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
    }
  }

  async rename(
    oldPath: string,
    newPath: string,
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
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

      // 2. Check if source file exists using session-aware check
      const existsResult = await this.exists(oldPath, sessionId);
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

      // 3. Rename file using SessionManager with mv command
      const escapedOldPath = shellEscape(oldPath);
      const escapedNewPath = shellEscape(newPath);
      const command = `mv ${escapedOldPath} ${escapedNewPath}`;

      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
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
      this.logger.error(
        'Failed to rename file',
        error instanceof Error ? error : undefined,
        { oldPath, newPath }
      );

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
    destinationPath: string,
    sessionId = 'default'
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

      // 2. Check if source exists using session-aware check
      const existsResult = await this.exists(sourcePath, sessionId);
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

      // 3. Move file using SessionManager with mv command
      // mv is atomic on same filesystem, automatically handles cross-filesystem moves
      const escapedSource = shellEscape(sourcePath);
      const escapedDest = shellEscape(destinationPath);
      const command = `mv ${escapedSource} ${escapedDest}`;

      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
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
      this.logger.error(
        'Failed to move file',
        error instanceof Error ? error : undefined,
        { sourcePath, destinationPath }
      );

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
    options: MkdirOptions = {},
    sessionId = 'default'
  ): Promise<ServiceResult<void>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Build mkdir command args (via manager)
      const args = this.manager.buildMkdirArgs(path, options);

      // 3. Build command string from args (skip 'mkdir' at index 0)
      const escapedPath = shellEscape(path);
      let command = 'mkdir';
      if (options.recursive) {
        command += ' -p';
      }
      command += ` ${escapedPath}`;

      // 4. Create directory using SessionManager
      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
      );

      if (!execResult.success) {
        return execResult as ServiceResult<void>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `mkdir operation failed with exit code ${result.exitCode}`,
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

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to create directory',
        error instanceof Error ? error : undefined,
        { path }
      );

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
    }
  }

  async exists(
    path: string,
    sessionId = 'default'
  ): Promise<ServiceResult<boolean>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Check if file/directory exists using SessionManager
      const escapedPath = shellEscape(path);
      const command = `test -e ${escapedPath}`;

      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
      );

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

  async stat(
    path: string,
    sessionId = 'default'
  ): Promise<ServiceResult<FileStats>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Check if file exists using session-aware check
      const existsResult = await this.exists(path, sessionId);
      if (!existsResult.success) {
        return existsResult as ServiceResult<FileStats>;
      }

      if (!existsResult.data) {
        return {
          success: false,
          error: {
            message: `Path not found: ${path}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path,
              operation: Operation.FILE_STAT
            } satisfies FileNotFoundContext
          }
        };
      }

      // 3. Build stat command args (via manager)
      const statCmd = this.manager.buildStatArgs(path);

      // 4. Build command string (stat with format argument)
      const escapedPath = shellEscape(path);
      const command = `stat ${statCmd.args[0]} ${statCmd.args[1]} ${escapedPath}`;

      // 5. Get file stats using SessionManager
      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        command
      );

      if (!execResult.success) {
        return execResult as ServiceResult<FileStats>;
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `stat operation failed with exit code ${result.exitCode}`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: { path, exitCode: result.exitCode, stderr: result.stderr }
          }
        };
      }

      // 6. Parse stat output (via manager)
      const stats = this.manager.parseStatOutput(result.stdout);

      // 7. Validate stats (via manager)
      const statsValidation = this.manager.validateStats(stats);
      if (!statsValidation.valid) {
        this.logger.warn('Stats validation warnings', {
          path,
          errors: statsValidation.errors
        });
      }

      return {
        success: true,
        data: stats
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to get file stats',
        error instanceof Error ? error : undefined,
        { path }
      );

      return {
        success: false,
        error: {
          message: `Failed to get file stats for '${path}': ${errorMessage}`,
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

  /**
   * Get file metadata
   * Optimized for scenarios where you need file characteristics
   * (size, type, encoding) before processing, without the overhead
   * of reading potentially large files. Used by readFileStreamOperation.
   */
  async getFileMetadata(
    path: string,
    sessionId = 'default'
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

      // 2. Check if file exists using session-aware check
      const existsResult = await this.exists(path, sessionId);
      if (!existsResult.success) {
        return {
          success: false,
          error: existsResult.error
        };
      }

      if (!existsResult.data) {
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

      // 3. Get file size using stat
      const escapedPath = shellEscape(path);
      const statCommand = `stat -c '%s' ${escapedPath} 2>/dev/null`;
      const statResult = await this.sessionManager.executeInSession(
        sessionId,
        statCommand
      );

      if (!statResult.success) {
        return {
          success: false,
          error: {
            message: `Failed to get file size for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: 'Command execution failed'
            } satisfies FileSystemContext
          }
        };
      }

      if (statResult.data.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to get file size for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: statResult.data.stderr
            } satisfies FileSystemContext
          }
        };
      }

      const fileSize = parseInt(statResult.data.stdout.trim(), 10);

      // 4. Detect MIME type using file command
      const mimeCommand = `file --mime-type -b ${escapedPath}`;
      const mimeResult = await this.sessionManager.executeInSession(
        sessionId,
        mimeCommand
      );

      if (!mimeResult.success) {
        return {
          success: false,
          error: {
            message: `Failed to detect MIME type for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: 'Command execution failed'
            } satisfies FileSystemContext
          }
        };
      }

      if (mimeResult.data.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to detect MIME type for '${path}'`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.FILE_READ,
              stderr: mimeResult.data.stderr
            } satisfies FileSystemContext
          }
        };
      }

      const mimeType = mimeResult.data.stdout.trim();

      // 5. Determine if file is binary based on MIME type
      const isBinary =
        !mimeType.startsWith('text/') &&
        !mimeType.includes('json') &&
        !mimeType.includes('xml') &&
        !mimeType.includes('javascript') &&
        !mimeType.includes('x-empty');

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
      this.logger.error(
        'Failed to get file metadata',
        error instanceof Error ? error : undefined,
        { path }
      );

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
    options?: ReadOptions,
    sessionId?: string
  ): Promise<ServiceResult<string, FileMetadata>> {
    return await this.read(path, options, sessionId);
  }

  async writeFile(
    path: string,
    content: string,
    options?: WriteOptions,
    sessionId?: string
  ): Promise<ServiceResult<void>> {
    return await this.write(path, content, options, sessionId);
  }

  async deleteFile(
    path: string,
    sessionId?: string
  ): Promise<ServiceResult<void>> {
    return await this.delete(path, sessionId);
  }

  async renameFile(
    oldPath: string,
    newPath: string,
    sessionId?: string
  ): Promise<ServiceResult<void>> {
    return await this.rename(oldPath, newPath, sessionId);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
    sessionId?: string
  ): Promise<ServiceResult<void>> {
    return await this.move(sourcePath, destinationPath, sessionId);
  }

  async createDirectory(
    path: string,
    options?: MkdirOptions,
    sessionId?: string
  ): Promise<ServiceResult<void>> {
    return await this.mkdir(path, options, sessionId);
  }

  async getFileStats(
    path: string,
    sessionId?: string
  ): Promise<ServiceResult<FileStats>> {
    return await this.stat(path, sessionId);
  }

  async listFiles(
    path: string,
    options?: ListFilesOptions,
    sessionId?: string
  ): Promise<ServiceResult<FileInfo[]>> {
    return await this.list(path, options, sessionId);
  }

  /**
   * List files in a directory
   * Returns detailed file information including permissions
   */
  async list(
    path: string,
    options: ListFilesOptions = {},
    sessionId = 'default'
  ): Promise<ServiceResult<FileInfo[]>> {
    try {
      // 1. Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
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

      // 2. Check if directory exists using session-aware check
      const existsResult = await this.exists(path, sessionId);
      if (!existsResult.success) {
        return {
          success: false,
          error: existsResult.error
        };
      }

      if (!existsResult.data) {
        return {
          success: false,
          error: {
            message: `Directory not found: ${path}`,
            code: ErrorCode.FILE_NOT_FOUND,
            details: {
              path,
              operation: Operation.DIRECTORY_LIST
            } satisfies FileNotFoundContext
          }
        };
      }

      // 3. Check if path is a directory
      const statResult = await this.stat(path, sessionId);
      if (statResult.success && !statResult.data.isDirectory) {
        return {
          success: false,
          error: {
            message: `Path is not a directory: ${path}`,
            code: ErrorCode.NOT_DIRECTORY,
            details: {
              path,
              operation: Operation.DIRECTORY_LIST
            } satisfies FileSystemContext
          }
        };
      }

      // 4. Build find command to list files
      const escapedPath = shellEscape(path);
      const basePath = path.endsWith('/') ? path.slice(0, -1) : path;

      // Use find with appropriate flags
      let findCommand = `find ${escapedPath}`;

      // Add maxdepth for non-recursive
      if (!options.recursive) {
        findCommand += ' -maxdepth 1';
      }

      // Filter hidden files unless includeHidden is true
      // Use -name to filter by basename only, not full path
      if (!options.includeHidden) {
        findCommand += ' -not -name ".*"';
      }

      // Skip the base directory itself and format output
      findCommand += ` -not -path ${escapedPath} -printf '%p\\t%y\\t%s\\t%TY-%Tm-%TdT%TH:%TM:%TS\\t%m\\n'`;

      const execResult = await this.sessionManager.executeInSession(
        sessionId,
        findCommand
      );

      if (!execResult.success) {
        return {
          success: false,
          error: execResult.error
        };
      }

      const result = execResult.data;

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Failed to list files in '${path}': ${
              result.stderr || `exit code ${result.exitCode}`
            }`,
            code: ErrorCode.FILESYSTEM_ERROR,
            details: {
              path,
              operation: Operation.DIRECTORY_LIST,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies FileSystemContext
          }
        };
      }

      // 5. Parse the output
      const files: FileInfo[] = [];

      const lines = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length !== 5) continue;

        const [absolutePath, typeChar, sizeStr, modifiedAt, modeStr] = parts;

        // Parse file type from find's format character
        let type: 'file' | 'directory' | 'symlink' | 'other';
        switch (typeChar) {
          case 'f':
            type = 'file';
            break;
          case 'd':
            type = 'directory';
            break;
          case 'l':
            type = 'symlink';
            break;
          default:
            type = 'other';
        }

        const size = parseInt(sizeStr, 10);
        const mode = parseInt(modeStr, 8); // Parse octal mode

        // Calculate relative path from base directory
        const relativePath = absolutePath.startsWith(`${basePath}/`)
          ? absolutePath.substring(basePath.length + 1)
          : absolutePath === basePath
            ? '.'
            : absolutePath.split('/').pop() || '';

        // Extract file name
        const name = absolutePath.split('/').pop() || '';

        // Convert mode to string format (rwxr-xr-x)
        const modeString = this.modeToString(mode);

        // Extract permissions for current user (owner permissions)
        const permissions = this.getPermissions(mode);

        files.push({
          name,
          absolutePath,
          relativePath,
          type,
          size,
          modifiedAt,
          mode: modeString,
          permissions
        });
      }

      return {
        success: true,
        data: files
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to list files',
        error instanceof Error ? error : undefined,
        { path }
      );

      return {
        success: false,
        error: {
          message: `Failed to list files in '${path}': ${errorMessage}`,
          code: ErrorCode.FILESYSTEM_ERROR,
          details: {
            path,
            operation: Operation.DIRECTORY_LIST,
            stderr: errorMessage
          } satisfies FileSystemContext
        }
      };
    }
  }

  /**
   * Convert numeric mode to string format like "rwxr-xr-x"
   */
  private modeToString(mode: number): string {
    const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
    const user = (mode >> 6) & 7;
    const group = (mode >> 3) & 7;
    const other = mode & 7;
    return perms[user] + perms[group] + perms[other];
  }

  /**
   * Extract permission booleans for current user (owner permissions)
   */
  private getPermissions(mode: number): {
    readable: boolean;
    writable: boolean;
    executable: boolean;
  } {
    const userPerms = (mode >> 6) & 7;
    return {
      readable: (userPerms & 4) !== 0,
      writable: (userPerms & 2) !== 0,
      executable: (userPerms & 1) !== 0
    };
  }

  /**
   * Stream a file using Server-Sent Events (SSE)
   * Sends metadata, chunks, and completion events
   * Uses 65535 byte chunks for proper base64 alignment
   */
  async readFileStreamOperation(
    path: string,
    sessionId = 'default'
  ): Promise<ReadableStream<Uint8Array>> {
    const encoder = new TextEncoder();
    const escapedPath = shellEscape(path);

    return new ReadableStream({
      start: async (controller) => {
        try {
          // 1. Get file metadata
          const metadataResult = await this.getFileMetadata(path, sessionId);

          if (!metadataResult.success) {
            const errorEvent = {
              type: 'error',
              error: metadataResult.error.message
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
            );
            controller.close();
            return;
          }

          const metadata = metadataResult.data;

          // 2. Send metadata event
          const metadataEvent = {
            type: 'metadata',
            mimeType: metadata.mimeType,
            size: metadata.size,
            isBinary: metadata.isBinary,
            encoding: metadata.encoding
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(metadataEvent)}\n\n`)
          );

          // 3. Stream file in chunks using dd
          // Chunk size of 65535 bytes (divisible by 3 for base64 alignment)
          const chunkSize = 65535;
          let bytesRead = 0;
          let blockNumber = 0;

          while (bytesRead < metadata.size) {
            // Use dd to read specific chunk
            const skip = blockNumber;
            const count = 1;

            let command: string;
            if (metadata.isBinary) {
              // Binary files: read as base64
              command = `dd if=${escapedPath} bs=${chunkSize} skip=${skip} count=${count} 2>/dev/null | base64 -w 0`;
            } else {
              // Text files: read as-is
              command = `dd if=${escapedPath} bs=${chunkSize} skip=${skip} count=${count} 2>/dev/null`;
            }

            const execResult = await this.sessionManager.executeInSession(
              sessionId,
              command
            );

            if (!execResult.success) {
              const errorEvent = {
                type: 'error',
                error: `Failed to read chunk at offset ${bytesRead}: Command execution failed`
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
              );
              controller.close();
              return;
            }

            if (execResult.data.exitCode !== 0) {
              const errorEvent = {
                type: 'error',
                error: `Failed to read chunk at offset ${bytesRead}: ${execResult.data.stderr}`
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
              );
              controller.close();
              return;
            }

            const chunkData = execResult.data.stdout;

            if (chunkData.length === 0) {
              // End of file
              break;
            }

            // Send chunk event
            const chunkEvent = {
              type: 'chunk',
              data: chunkData
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunkEvent)}\n\n`)
            );

            // Calculate actual bytes read
            // For text files: use the actual length of the data
            // For binary files: decode base64 length (every 4 base64 chars = 3 bytes)
            let actualBytesRead: number;
            if (metadata.isBinary) {
              // Base64 decoding: 4 chars = 3 bytes
              // Handle padding: remove '=' characters before calculating
              const base64Length = chunkData.replace(/=/g, '').length;
              actualBytesRead = Math.floor((base64Length * 3) / 4);
            } else {
              actualBytesRead = chunkData.length;
            }

            bytesRead += actualBytesRead;
            blockNumber++;
          }

          // 4. Send complete event
          const completeEvent = {
            type: 'complete',
            bytesRead: metadata.size
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(completeEvent)}\n\n`)
          );
          controller.close();
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          this.logger.error(
            'File streaming failed',
            error instanceof Error ? error : undefined,
            { path }
          );

          const errorEvent = {
            type: 'error',
            error: errorMessage
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
          );
          controller.close();
        }
      }
    });
  }
}
