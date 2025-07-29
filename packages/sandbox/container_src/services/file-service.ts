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
  read(path: string, options?: ReadOptions): Promise<string>;
  write(path: string, content: string, options?: WriteOptions): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  move(sourcePath: string, destinationPath: string): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStats>;
}

export class FileService implements FileSystemOperations {
  constructor(
    private security: SecurityService,
    private logger: Logger
  ) {}

  async read(path: string, options: ReadOptions = {}): Promise<string> {
    // Validate path for security
    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      throw new Error(`Security validation failed: ${validation.errors.join(', ')}`);
    }

    this.logger.info('Reading file', { path, encoding: options.encoding });

    try {
      // Use Bun's native file API for 3-5x better performance than Node.js fs
      const file = Bun.file(path);
      
      // Check if file exists first
      if (!(await file.exists())) {
        throw new Error(`File not found: ${path}`);
      }

      const content = await file.text();
      
      this.logger.info('File read successfully', { 
        path, 
        sizeBytes: content.length 
      });

      return content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to read file', error instanceof Error ? error : undefined, { path });
      throw new Error(`Failed to read file ${path}: ${errorMessage}`);
    }
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    // Validate path for security
    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      throw new Error(`Security validation failed: ${validation.errors.join(', ')}`);
    }

    this.logger.info('Writing file', { 
      path, 
      sizeBytes: content.length,
      encoding: options.encoding 
    });

    try {
      // Use Bun's optimized write with zero-copy operations
      await Bun.write(path, content);
      
      this.logger.info('File written successfully', { 
        path, 
        sizeBytes: content.length 
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to write file', error instanceof Error ? error : undefined, { path });
      throw new Error(`Failed to write file ${path}: ${errorMessage}`);
    }
  }

  async delete(path: string): Promise<void> {
    // Validate path for security
    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      throw new Error(`Security validation failed: ${validation.errors.join(', ')}`);
    }

    this.logger.info('Deleting file', { path });

    try {
      const file = Bun.file(path);
      
      // Check if file exists
      if (!(await file.exists())) {
        throw new Error(`File not found: ${path}`);
      }

      // Delete the file
      await file.remove?.() ?? Bun.spawn(['rm', path]).exited;
      
      this.logger.info('File deleted successfully', { path });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to delete file', error instanceof Error ? error : undefined, { path });
      throw new Error(`Failed to delete file ${path}: ${errorMessage}`);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // Validate both paths for security
    const oldValidation = this.security.validatePath(oldPath);
    const newValidation = this.security.validatePath(newPath);
    
    if (!oldValidation.isValid || !newValidation.isValid) {
      const errors = [...oldValidation.errors, ...newValidation.errors];
      throw new Error(`Security validation failed: ${errors.join(', ')}`);
    }

    this.logger.info('Renaming file', { oldPath, newPath });

    try {
      // Check if source file exists
      const sourceFile = Bun.file(oldPath);
      if (!(await sourceFile.exists())) {
        throw new Error(`Source file not found: ${oldPath}`);
      }

      // Use system rename for efficiency
      const proc = Bun.spawn(['mv', oldPath, newPath]);
      await proc.exited;
      
      if (proc.exitCode !== 0) {
        throw new Error(`Rename operation failed with exit code ${proc.exitCode}`);
      }
      
      this.logger.info('File renamed successfully', { oldPath, newPath });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to rename file', error instanceof Error ? error : undefined, { oldPath, newPath });
      throw new Error(`Failed to rename file from ${oldPath} to ${newPath}: ${errorMessage}`);
    }
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    // Validate both paths for security
    const sourceValidation = this.security.validatePath(sourcePath);
    const destValidation = this.security.validatePath(destinationPath);
    
    if (!sourceValidation.isValid || !destValidation.isValid) {
      const errors = [...sourceValidation.errors, ...destValidation.errors];
      throw new Error(`Security validation failed: ${errors.join(', ')}`);
    }

    this.logger.info('Moving file', { sourcePath, destinationPath });

    try {
      // For move operations, we can use zero-copy operations with Bun
      const sourceFile = Bun.file(sourcePath);
      
      // Check if source exists
      if (!(await sourceFile.exists())) {
        throw new Error(`Source file not found: ${sourcePath}`);
      }

      // Use Bun's zero-copy file operations
      await Bun.write(destinationPath, sourceFile);
      
      // Remove the source file
      await sourceFile.remove?.() ?? Bun.spawn(['rm', sourcePath]).exited;
      
      this.logger.info('File moved successfully', { sourcePath, destinationPath });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to move file', error instanceof Error ? error : undefined, { sourcePath, destinationPath });
      throw new Error(`Failed to move file from ${sourcePath} to ${destinationPath}: ${errorMessage}`);
    }
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    // Validate path for security
    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      throw new Error(`Security validation failed: ${validation.errors.join(', ')}`);
    }

    this.logger.info('Creating directory', { path, recursive: options.recursive });

    try {
      const args = ['mkdir'];
      if (options.recursive) {
        args.push('-p');
      }
      args.push(path);

      const proc = Bun.spawn(args);
      await proc.exited;
      
      if (proc.exitCode !== 0) {
        throw new Error(`mkdir operation failed with exit code ${proc.exitCode}`);
      }
      
      this.logger.info('Directory created successfully', { path });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create directory', error instanceof Error ? error : undefined, { path });
      throw new Error(`Failed to create directory ${path}: ${errorMessage}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const file = Bun.file(path);
      return await file.exists();
    } catch (error) {
      // If there's an error checking existence, assume it doesn't exist
      this.logger.warn('Error checking file existence', { path, error: error instanceof Error ? error.message : 'Unknown error' });
      return false;
    }
  }

  async stat(path: string): Promise<FileStats> {
    // Validate path for security
    const validation = this.security.validatePath(path);
    if (!validation.isValid) {
      throw new Error(`Security validation failed: ${validation.errors.join(', ')}`);
    }

    try {
      const file = Bun.file(path);
      
      if (!(await file.exists())) {
        throw new Error(`Path not found: ${path}`);
      }

      // Get file stats using system stat command for full info
      const proc = Bun.spawn(['stat', '-c', '%F:%s:%Y:%W', path], {
        stdout: 'pipe',
      });
      
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      
      if (proc.exitCode !== 0) {
        throw new Error(`stat operation failed with exit code ${proc.exitCode}`);
      }

      const [type, size, modified, created] = output.trim().split(':');
      
      return {
        isFile: type.includes('regular file'),
        isDirectory: type.includes('directory'),
        size: parseInt(size, 10),
        modified: new Date(parseInt(modified, 10) * 1000),
        created: new Date(parseInt(created, 10) * 1000),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get file stats', error instanceof Error ? error : undefined, { path });
      throw new Error(`Failed to get stats for ${path}: ${errorMessage}`);
    }
  }

  // Convenience methods with ServiceResult wrapper for higher-level operations

  async readFile(path: string, options?: ReadOptions): Promise<ServiceResult<string>> {
    try {
      const content = await this.read(path, options);
      return {
        success: true,
        data: content,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'FILE_READ_ERROR',
          details: { path, options },
        },
      };
    }
  }

  async writeFile(path: string, content: string, options?: WriteOptions): Promise<ServiceResult<void>> {
    try {
      await this.write(path, content, options);
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'FILE_WRITE_ERROR',
          details: { path, sizeBytes: content.length, options },
        },
      };
    }
  }

  async deleteFile(path: string): Promise<ServiceResult<void>> {
    try {
      await this.delete(path);
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'FILE_DELETE_ERROR',
          details: { path },
        },
      };
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<ServiceResult<void>> {
    try {
      await this.rename(oldPath, newPath);
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'FILE_RENAME_ERROR',
          details: { oldPath, newPath },
        },
      };
    }
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<ServiceResult<void>> {
    try {
      await this.move(sourcePath, destinationPath);
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'FILE_MOVE_ERROR',
          details: { sourcePath, destinationPath },
        },
      };
    }
  }

  async createDirectory(path: string, options?: MkdirOptions): Promise<ServiceResult<void>> {
    try {
      await this.mkdir(path, options);
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'DIRECTORY_CREATE_ERROR',
          details: { path, options },
        },
      };
    }
  }

  async getFileStats(path: string): Promise<ServiceResult<FileStats>> {
    try {
      const stats = await this.stat(path);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: errorMessage,
          code: 'FILE_STAT_ERROR',
          details: { path },
        },
      };
    }
  }
}