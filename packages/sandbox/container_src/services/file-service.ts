// Bun-optimized File System Service
import type { 
  FileStats, 
  ReadOptions, 
  WriteOptions, 
  MkdirOptions, 
  Logger, 
  ServiceResult 
} from '../core/types';

export interface SecurityService {
  validatePath(path: string): { isValid: boolean; errors: string[] };
  sanitizePath(path: string): string;
}

// File system operations interface
export interface FileSystemOperations {
  read(path: string, options?: ReadOptions): Promise<ServiceResult<string>>;
  write(path: string, content: string, options?: WriteOptions): Promise<ServiceResult<void>>;
  delete(path: string): Promise<ServiceResult<void>>;
  rename(oldPath: string, newPath: string): Promise<ServiceResult<void>>;
  move(sourcePath: string, destinationPath: string): Promise<ServiceResult<void>>;
  mkdir(path: string, options?: MkdirOptions): Promise<ServiceResult<void>>;
  exists(path: string): Promise<ServiceResult<boolean>>;
  stat(path: string): Promise<ServiceResult<FileStats>>;
}

export class FileService implements FileSystemOperations {
  constructor(
    private security: SecurityService,
    private logger: Logger
  ) {}

  async read(path: string, options: ReadOptions = {}): Promise<ServiceResult<string>> {
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

      // Use Bun's native file API for 3-5x better performance than Node.js fs
      const file = Bun.file(path);
      
      // Check if file exists first
      if (!(await file.exists())) {
        return {
          success: false,
          error: {
            message: `File not found: ${path}`,
            code: 'FILE_NOT_FOUND',
            details: { path }
          }
        };
      }

      const content = await file.text();
      
      this.logger.info('File read successfully', { 
        path, 
        sizeBytes: content.length 
      });

      return {
        success: true,
        data: content
      };
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

  async write(path: string, content: string, options: WriteOptions = {}): Promise<ServiceResult<void>> {
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

      // Use Bun's optimized write with zero-copy operations
      await Bun.write(path, content);
      
      this.logger.info('File written successfully', { 
        path, 
        sizeBytes: content.length 
      });

      return {
        success: true
      };
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

  async delete(path: string): Promise<ServiceResult<void>> {
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

      const file = Bun.file(path);
      
      // Check if file exists
      if (!(await file.exists())) {
        return {
          success: false,
          error: {
            message: `File not found: ${path}`,
            code: 'FILE_NOT_FOUND',
            details: { path }
          }
        };
      }

      // Delete the file using fs.unlink since Bun.file doesn't have remove method
      await Bun.spawn(['rm', path]).exited;
      
      this.logger.info('File deleted successfully', { path });

      return {
        success: true
      };
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

  async rename(oldPath: string, newPath: string): Promise<ServiceResult<void>> {
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

      // Check if source file exists
      const sourceFile = Bun.file(oldPath);
      if (!(await sourceFile.exists())) {
        return {
          success: false,
          error: {
            message: `Source file not found: ${oldPath}`,
            code: 'FILE_NOT_FOUND',
            details: { oldPath, newPath }
          }
        };
      }

      // Use system rename for efficiency
      const proc = Bun.spawn(['mv', oldPath, newPath]);
      await proc.exited;
      
      if (proc.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `Rename operation failed with exit code ${proc.exitCode}`,
            code: 'RENAME_ERROR',
            details: { oldPath, newPath, exitCode: proc.exitCode }
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
          code: 'RENAME_ERROR',
          details: { oldPath, newPath, originalError: errorMessage }
        }
      };
    }
  }

  async move(sourcePath: string, destinationPath: string): Promise<ServiceResult<void>> {
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

      // For move operations, we can use zero-copy operations with Bun
      const sourceFile = Bun.file(sourcePath);
      
      // Check if source exists
      if (!(await sourceFile.exists())) {
        return {
          success: false,
          error: {
            message: `Source file not found: ${sourcePath}`,
            code: 'FILE_NOT_FOUND',
            details: { sourcePath, destinationPath }
          }
        };
      }

      // Use Bun's zero-copy file operations
      await Bun.write(destinationPath, sourceFile);
      
      // Remove the source file using rm command
      await Bun.spawn(['rm', sourcePath]).exited;
      
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
          code: 'MOVE_ERROR',
          details: { sourcePath, destinationPath, originalError: errorMessage }
        }
      };
    }
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<ServiceResult<void>> {
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

      const args = ['mkdir'];
      if (options.recursive) {
        args.push('-p');
      }
      args.push(path);

      const proc = Bun.spawn(args);
      await proc.exited;
      
      if (proc.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `mkdir operation failed with exit code ${proc.exitCode}`,
            code: 'MKDIR_ERROR',
            details: { path, options, exitCode: proc.exitCode }
          }
        };
      }
      
      this.logger.info('Directory created successfully', { path });

      return {
        success: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create directory', error instanceof Error ? error : undefined, { path });
      
      return {
        success: false,
        error: {
          message: `Failed to create directory ${path}: ${errorMessage}`,
          code: 'MKDIR_ERROR',
          details: { path, options, originalError: errorMessage }
        }
      };
    }
  }

  async exists(path: string): Promise<ServiceResult<boolean>> {
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
      const exists = await file.exists();
      
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

  async stat(path: string): Promise<ServiceResult<FileStats>> {
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

      // Get file stats using system stat command for full info
      const proc = Bun.spawn(['stat', '-c', '%F:%s:%Y:%W', path], {
        stdout: 'pipe',
      });
      
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      
      if (proc.exitCode !== 0) {
        return {
          success: false,
          error: {
            message: `stat operation failed with exit code ${proc.exitCode}`,
            code: 'STAT_ERROR',
            details: { path, exitCode: proc.exitCode }
          }
        };
      }

      const [type, size, modified, created] = output.trim().split(':');
      
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
          code: 'STAT_ERROR',
          details: { path, originalError: errorMessage }
        }
      };
    }
  }

  // Convenience methods with ServiceResult wrapper for higher-level operations

  async readFile(path: string, options?: ReadOptions): Promise<ServiceResult<string>> {
    return await this.read(path, options);
  }

  async writeFile(path: string, content: string, options?: WriteOptions): Promise<ServiceResult<void>> {
    return await this.write(path, content, options);
  }

  async deleteFile(path: string): Promise<ServiceResult<void>> {
    return await this.delete(path);
  }

  async renameFile(oldPath: string, newPath: string): Promise<ServiceResult<void>> {
    return await this.rename(oldPath, newPath);
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<ServiceResult<void>> {
    return await this.move(sourcePath, destinationPath);
  }

  async createDirectory(path: string, options?: MkdirOptions): Promise<ServiceResult<void>> {
    return await this.mkdir(path, options);
  }

  async getFileStats(path: string): Promise<ServiceResult<FileStats>> {
    return await this.stat(path);
  }
}