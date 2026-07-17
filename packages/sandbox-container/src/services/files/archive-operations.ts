import type { FileInfo, ListFilesOptions } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import type {
  FileNotFoundContext,
  FileSystemContext,
  ValidationFailedContext
} from '@repo/shared/errors';
import { ErrorCode, Operation } from '@repo/shared/errors';
import type { FileStats, MkdirOptions, ServiceResult } from '../../core/types';
import { FileTreeOperations } from './tree-operations';

export class FileArchiveOperations extends FileTreeOperations {
  async stat(path: string): Promise<ServiceResult<FileStats>> {
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

      // 2. Check if file exists using execution-context check
      const existsResult = await this.exists(path);
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

      // 5. Get file stats using the unified execution path
      const execResult = await this.executeInternal(command);

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
   * Get file metadata (size, MIME type, binary/text classification).
   */
  async deleteFile(path: string): Promise<ServiceResult<void>> {
    return await this.delete(path);
  }

  async renameFile(
    oldPath: string,
    newPath: string
  ): Promise<ServiceResult<void>> {
    return await this.rename(oldPath, newPath);
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<ServiceResult<void>> {
    return await this.move(sourcePath, destinationPath);
  }

  async createDirectory(
    path: string,
    options?: MkdirOptions
  ): Promise<ServiceResult<void>> {
    return await this.mkdir(path, options);
  }

  async getFileStats(path: string): Promise<ServiceResult<FileStats>> {
    return await this.stat(path);
  }

  async listFiles(
    path: string,
    options?: ListFilesOptions
  ): Promise<ServiceResult<FileInfo[]>> {
    return await this.list(path, options);
  }

  /**
   * List files in a directory
   * Returns detailed file information including permissions
   */
  async list(
    path: string,
    options: ListFilesOptions = {}
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

      // 2. Check if directory exists using execution-context check
      const existsResult = await this.exists(path);
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
      const statResult = await this.stat(path);
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

      const execResult = await this.executeInternal(findCommand);

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
}
