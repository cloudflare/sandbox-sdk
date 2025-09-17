// Session-Aware File System Service
import type { 
  FileInfo,
  FileStats, 
  Logger,
  MkdirOptions, 
  ReadOptions, 
  ServiceResult, 
  WriteOptions 
} from '../core/types';
import type { SessionManager } from '../isolation';
import { SessionAwareService } from './base/session-aware-service';

export interface SecurityService {
  validatePath(path: string): { isValid: boolean; errors: string[] };
  sanitizePath(path: string): string;
}

export class FileService extends SessionAwareService {
  constructor(
    private security: SecurityService,
    sessionManager: SessionManager,
    logger: Logger
  ) {
    super(sessionManager, logger);
  }

  async read(path: string, sessionId?: string, options: ReadOptions = {}): Promise<ServiceResult<string>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      this.logger.info('Reading file', { path, encoding: options.encoding });

      // Build file read command - ALL file logic consolidated here
      const command = `cat "${path}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `File read session error: ${result.error.message}`,
            code: 'FILE_READ_SESSION_ERROR',
            details: { ...result.error.details, path, encoding: options.encoding }
          }
        };
      }

      // Process file read results - handle command success/failure
      if (result.data.success) {
        this.logger.info('File read successfully', { 
          path, 
          sizeBytes: result.data.stdout.length 
        });

        return {
          success: true,
          data: result.data.stdout
        };
      } else {
        // File read command failed (file not found, permissions, etc.)
        return {
          success: false,
          error: {
            message: `File read failed: ${path}`,
            code: 'FILE_READ_ERROR',
            details: { 
              path, 
              encoding: options.encoding,
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to read file', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to read file ${path}: ${errorMessage}`,
          code: 'FILE_READ_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  async write(path: string, content: string, sessionId?: string, options: WriteOptions = {}): Promise<ServiceResult<void>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      this.logger.info('Writing file', { 
        path, 
        sizeBytes: content.length,
        encoding: options.encoding 
      });

      // Build file write command using heredoc - ALL file logic consolidated here
      // Note: The quoted heredoc delimiter 'SANDBOX_EOF' prevents variable expansion
      const command = `mkdir -p "$(dirname "${path}")" && cat > "${path}" << 'SANDBOX_EOF'
${content}
SANDBOX_EOF`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `File write session error: ${result.error.message}`,
            code: 'FILE_WRITE_SESSION_ERROR',
            details: { ...result.error.details, path, contentSize: content.length, encoding: options.encoding }
          }
        };
      }

      // Process file write results - handle command success/failure
      if (result.data.success) {
        this.logger.info('File written successfully', { 
          path, 
          sizeBytes: content.length 
        });

        return {
          success: true
        };
      } else {
        // File write command failed (permissions, disk space, etc.)
        return {
          success: false,
          error: {
            message: `File write failed: ${path}`,
            code: 'FILE_WRITE_ERROR',
            details: { 
              path, 
              contentSize: content.length,
              encoding: options.encoding,
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to write file', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to write file ${path}: ${errorMessage}`,
          code: 'FILE_WRITE_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  async delete(path: string, sessionId?: string): Promise<ServiceResult<void>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      this.logger.info('Deleting file', { path });

      // Build file delete command - ALL file logic consolidated here
      const command = `rm "${path}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `File delete session error: ${result.error.message}`,
            code: 'FILE_DELETE_SESSION_ERROR',
            details: { ...result.error.details, path }
          }
        };
      }

      // Process file delete results - handle command success/failure
      if (result.data.success) {
        this.logger.info('File deleted successfully', { path });

        return {
          success: true
        };
      } else {
        // File delete command failed (file not found, permissions, etc.)
        return {
          success: false,
          error: {
            message: `File delete failed: ${path}`,
            code: 'FILE_DELETE_ERROR',
            details: { 
              path,
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to delete file', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to delete file ${path}: ${errorMessage}`,
          code: 'FILE_DELETE_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  async rename(oldPath: string, newPath: string, sessionId?: string): Promise<ServiceResult<void>> {
    try {
      // Validate both paths for security
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

      this.logger.info('Renaming file', { oldPath, newPath });

      // Build rename command - ALL rename logic consolidated here
      const command = `mv "${oldPath}" "${newPath}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Rename session error: ${result.error.message}`,
            code: 'RENAME_SESSION_ERROR',
            details: { ...result.error.details, oldPath, newPath }
          }
        };
      }

      // Process rename results - handle command success/failure
      if (!result.data.success) {
        return {
          success: false,
          error: {
            message: `Rename operation failed`,
            code: 'FILE_RENAME_ERROR',
            details: { 
              oldPath, 
              newPath, 
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }
      
      this.logger.info('File renamed successfully', { oldPath, newPath });

      return {
        success: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to rename file', error instanceof Error ? error : undefined, { oldPath, newPath });
      
      return {
        success: false,
        error: {
          message: `Failed to rename file from ${oldPath} to ${newPath}: ${errorMessage}`,
          code: 'FILE_RENAME_ERROR',
          details: { oldPath, newPath, originalError: errorMessage }
        }
      };
    }
  }

  async move(sourcePath: string, destinationPath: string, sessionId?: string): Promise<ServiceResult<void>> {
    try {
      // Validate both paths for security
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

      this.logger.info('Moving file', { sourcePath, destinationPath });

      // Build move command - ALL move logic consolidated here  
      const command = `mv "${sourcePath}" "${destinationPath}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Move session error: ${result.error.message}`,
            code: 'MOVE_SESSION_ERROR',
            details: { ...result.error.details, sourcePath, destinationPath }
          }
        };
      }

      // Process move results - handle command success/failure
      if (!result.data.success) {
        return {
          success: false,
          error: {
            message: `File move failed`,
            code: 'FILE_MOVE_ERROR',
            details: { 
              sourcePath,
              destinationPath,
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }
      
      this.logger.info('File moved successfully', { sourcePath, destinationPath });

      return {
        success: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to move file', error instanceof Error ? error : undefined, { sourcePath, destinationPath });
      
      return {
        success: false,
        error: {
          message: `Failed to move file from ${sourcePath} to ${destinationPath}: ${errorMessage}`,
          code: 'FILE_MOVE_ERROR',
          details: { sourcePath, destinationPath, originalError: errorMessage }
        }
      };
    }
  }

  async mkdir(path: string, sessionId?: string, options: MkdirOptions = {}): Promise<ServiceResult<void>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      this.logger.info('Creating directory', { path, recursive: options.recursive });

      // Build mkdir command - ALL directory logic consolidated here
      const command = options.recursive ? `mkdir -p "${path}"` : `mkdir "${path}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Directory creation session error: ${result.error.message}`,
            code: 'MKDIR_SESSION_ERROR',
            details: { ...result.error.details, path, recursive: options.recursive }
          }
        };
      }

      // Process mkdir results - handle command success/failure
      if (result.data.success) {
        this.logger.info('Directory created successfully', { path });

        return {
          success: true
        };
      } else {
        // Directory creation command failed (permissions, parent doesn't exist, etc.)
        return {
          success: false,
          error: {
            message: `Directory creation failed: ${path}`,
            code: 'FILE_MKDIR_ERROR',
            details: { 
              path,
              recursive: options.recursive,
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create directory', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to create directory ${path}: ${errorMessage}`,
          code: 'FILE_MKDIR_ERROR',
          details: { path, options, originalError: errorMessage }
        }
      };
    }
  }

  async exists(path: string, sessionId?: string): Promise<ServiceResult<boolean>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      // Build existence check command - ALL existence logic consolidated here
      const command = `test -e "${path}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Existence check session error: ${result.error.message}`,
            code: 'EXISTS_SESSION_ERROR',
            details: { ...result.error.details, path }
          }
        };
      }

      // test command: exit code 0 = exists, non-zero = doesn't exist
      const exists = result.data.exitCode === 0;
      
      return {
        success: true,
        data: exists
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Error checking file existence', { path, error: errorMessage });
      
      return {
        success: false,
        error: {
          message: `Failed to check if file exists ${path}: ${errorMessage}`,
          code: 'EXISTS_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  async stat(path: string, sessionId?: string): Promise<ServiceResult<FileStats>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      const file = Bun.file(path);
      
      if (!(await file.exists())) {
        return {
          success: false,
          error: {
            message: `Path not found: ${path}`,
            code: 'FILE_NOT_FOUND',
            details: { path }
          }
        };
      }

      // Build stat command - ALL stat logic consolidated here
      const command = `stat -c '%F:%s:%Y:%W' "${path}"`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Stat session error: ${result.error.message}`,
            code: 'STAT_SESSION_ERROR',
            details: { ...result.error.details, path }
          }
        };
      }

      // Process stat results - handle command success/failure
      if (!result.data.success) {
        return {
          success: false,
          error: {
            message: `stat operation failed`,
            code: 'FILE_STAT_ERROR',
            details: { 
              path, 
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }

      const [type, size, modified, created] = result.data.stdout.trim().split(':');
      
      const stats: FileStats = {
        isFile: type.includes('regular file'),
        isDirectory: type.includes('directory'),
        size: parseInt(size, 10),
        modified: new Date(parseInt(modified, 10) * 1000),
        created: new Date(parseInt(created, 10) * 1000),
      };

      return {
        success: true,
        data: stats
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get file stats', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to get stats for ${path}: ${errorMessage}`,
          code: 'FILE_STAT_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  async listFiles(path: string, sessionId?: string): Promise<ServiceResult<FileInfo[]>> {
    try {
      // Validate path for security
      const validation = this.security.validatePath(path);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Security validation failed: ${validation.errors.join(', ')}`,
            code: 'SECURITY_VALIDATION_FAILED',
            details: { path, errors: validation.errors }
          }
        };
      }

      this.logger.info('Listing files in directory', { path });

      // Build directory listing command - ALL listing logic consolidated here
      // Use find with printf to get all file info in one call, avoiding multiple stat calls
      const command = `find "${path}" -maxdepth 1 -mindepth 1 -printf '%f:%p:%y:%s:%T@:%C@\n'`;
      const result = await this.executeInSession(command, sessionId);
      
      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Directory listing session error: ${result.error.message}`,
            code: 'LIST_SESSION_ERROR',
            details: { ...result.error.details, path }
          }
        };
      }

      // Process listing results - handle command success/failure
      if (!result.data.success) {
        return {
          success: false,
          error: {
            message: `Directory listing failed`,
            code: 'LIST_ERROR',
            details: { 
              path, 
              exitCode: result.data.exitCode,
              stderr: result.data.stderr
            }
          }
        };
      }

      // Parse find output into FileInfo objects - ALL parsing logic here
      const files: FileInfo[] = [];
      const lines = result.data.stdout.trim().split('\n').filter(line => line.length > 0);
      
      for (const line of lines) {
        try {
          const [name, fullPath, type, size, modified, created] = line.split(':');
          
          // Skip . and .. entries
          if (name === '.' || name === '..') {
            continue;
          }

          const fileInfo: FileInfo = {
            name,
            path: fullPath,
            isFile: type === 'f',
            isDirectory: type === 'd',
            size: parseInt(size, 10),
            modified: new Date(parseFloat(modified) * 1000),
            created: new Date(parseFloat(created) * 1000),
          };

          files.push(fileInfo);
        } catch (parseError) {
          // Skip entries that can't be parsed - ALL error handling here
          this.logger.warn('Failed to parse file entry', { 
            line, 
            error: parseError instanceof Error ? parseError.message : 'Unknown error' 
          });
        }
      }

      this.logger.info('Directory listing completed', { 
        path, 
        fileCount: files.length 
      });

      return {
        success: true,
        data: files
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list directory contents', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to list directory ${path}: ${errorMessage}`,
          code: 'LIST_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  // Note: Handler layer calls these methods directly (read, write, delete, etc.)
  // No wrapper methods needed - keeping the interface clean and discoverable
}