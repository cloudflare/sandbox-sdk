/**
 * FileManager - Pure Business Logic for File Operations
 *
 * Handles file operation logic without any I/O dependencies.
 * Extracted from FileService to enable fast unit testing.
 *
 * Responsibilities:
 * - Parsing file statistics
 * - Building command arguments
 * - Creating error structures
 * - Operation planning and validation
 *
 * NO I/O operations - all infrastructure delegated to BunFileAdapter
 */

import type { FileStats, MkdirOptions } from '../core/types';

export interface FileOperationPlan {
  operation: 'read' | 'write' | 'delete' | 'rename' | 'move' | 'mkdir' | 'stat';
  paths: string[];
  requiresCheck?: boolean;
  command?: {
    executable: string;
    args: string[];
  };
}

export interface ParsedStats {
  type: string;
  size: number;
  modified: number;
  created: number;
}

/**
 * FileManager contains pure business logic for file operations.
 * No Bun APIs, no I/O - just pure functions that can be unit tested instantly.
 */
export class FileManager {
  /**
   * Parse stat command output into FileStats object
   * Format: "type:size:modified:created"
   *
   * Supports both:
   * - GNU stat (Linux): "regular file:1024:1672531200:1672531100"
   * - BSD stat (macOS): "Regular File:1024:1672531200:1672531100"
   */
  parseStatOutput(output: string): FileStats {
    const parts = output.trim().split(':');

    if (parts.length < 4) {
      throw new Error(
        `Invalid stat output format: expected 4 parts, got ${parts.length}`
      );
    }

    const [type, size, modified, created] = parts;

    // Normalize type string to lowercase for consistent checking
    const normalizedType = type.toLowerCase();

    return {
      isFile: normalizedType.includes('regular file'),
      isDirectory: normalizedType.includes('directory'),
      size: parseInt(size, 10),
      modified: new Date(parseInt(modified, 10) * 1000),
      created: new Date(parseInt(created, 10) * 1000)
    };
  }

  /**
   * Build mkdir command arguments based on options
   */
  buildMkdirArgs(path: string, options: MkdirOptions = {}): string[] {
    const args = ['mkdir'];

    if (options.recursive) {
      args.push('-p');
    }

    args.push(path);

    return args;
  }

  /**
   * Build stat command arguments for getting file stats
   * Uses format: type:size:modified:created
   */
  buildStatArgs(path: string): {
    command: string;
    args: string[];
    format: string;
  } {
    return {
      command: 'stat',
      args: ['-c', '%F:%s:%Y:%W', path],
      format: 'type:size:modified:created'
    };
  }

  /**
   * Determine appropriate error code based on operation and error type
   */
  determineErrorCode(operation: string, error: Error | string): string {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const lowerMessage = errorMessage.toLowerCase();

    // Common error patterns
    if (lowerMessage.includes('not found') || lowerMessage.includes('enoent')) {
      return 'FILE_NOT_FOUND';
    }

    if (
      lowerMessage.includes('permission') ||
      lowerMessage.includes('eacces')
    ) {
      return 'PERMISSION_DENIED';
    }

    if (lowerMessage.includes('exists') || lowerMessage.includes('eexist')) {
      return 'FILE_EXISTS';
    }

    if (lowerMessage.includes('disk full') || lowerMessage.includes('enospc')) {
      return 'DISK_FULL';
    }

    if (
      lowerMessage.includes('directory not empty') ||
      lowerMessage.includes('enotempty')
    ) {
      return 'DIR_NOT_EMPTY';
    }

    // Operation-specific defaults
    switch (operation) {
      case 'read':
        return 'FILE_READ_ERROR';
      case 'write':
        return 'FILE_WRITE_ERROR';
      case 'delete':
        return 'FILE_DELETE_ERROR';
      case 'rename':
        return 'RENAME_ERROR';
      case 'move':
        return 'MOVE_ERROR';
      case 'mkdir':
        return 'MKDIR_ERROR';
      case 'stat':
        return 'STAT_ERROR';
      case 'exists':
        return 'EXISTS_ERROR';
      default:
        return 'FILE_OPERATION_ERROR';
    }
  }

  /**
   * Validate file statistics are reasonable
   */
  validateStats(stats: FileStats): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (stats.size < 0) {
      errors.push('File size cannot be negative');
    }

    if (stats.size > Number.MAX_SAFE_INTEGER) {
      errors.push('File size exceeds maximum safe integer');
    }

    if (stats.modified < new Date('1970-01-01')) {
      errors.push('Modified date cannot be before Unix epoch');
    }

    if (stats.created < new Date('1970-01-01')) {
      errors.push('Created date cannot be before Unix epoch');
    }

    if (stats.modified < stats.created) {
      // This is actually valid - files can be "created" (birth time) before "modified" (last write)
      // in some edge cases, so we'll just warn but not error
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Plan a file operation - determines what checks and commands are needed
   */
  planOperation(operation: string, ...paths: string[]): FileOperationPlan {
    switch (operation) {
      case 'read':
        return {
          operation: 'read',
          paths: [paths[0]],
          requiresCheck: true
        };

      case 'write':
        return {
          operation: 'write',
          paths: [paths[0]],
          requiresCheck: false
        };

      case 'delete':
        return {
          operation: 'delete',
          paths: [paths[0]],
          requiresCheck: true,
          command: {
            executable: 'rm',
            args: [paths[0]]
          }
        };

      case 'rename':
        return {
          operation: 'rename',
          paths: [paths[0], paths[1]],
          requiresCheck: true,
          command: {
            executable: 'mv',
            args: [paths[0], paths[1]]
          }
        };

      case 'move':
        return {
          operation: 'move',
          paths: [paths[0], paths[1]],
          requiresCheck: true
        };

      case 'mkdir':
        return {
          operation: 'mkdir',
          paths: [paths[0]],
          requiresCheck: false
        };

      case 'stat':
        return {
          operation: 'stat',
          paths: [paths[0]],
          requiresCheck: true
        };

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  /**
   * Determine if an operation should use move or copy+delete
   * (in same filesystem = move, across filesystems = copy+delete)
   */
  shouldUseMoveCommand(sourcePath: string, destPath: string): boolean {
    // Extract the root mount point (first path segment after /)
    const sourceRoot = sourcePath.split('/')[1];
    const destRoot = destPath.split('/')[1];

    // If same root, likely same filesystem
    return sourceRoot === destRoot;
  }

  /**
   * Format file size for human-readable display
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / k ** i).toFixed(2))} ${units[i]}`;
  }

  /**
   * Create a standardized error message for file operations
   */
  createErrorMessage(operation: string, path: string, error: string): string {
    const operationVerbs: Record<string, string> = {
      read: 'read',
      write: 'write',
      delete: 'delete',
      rename: 'rename',
      move: 'move',
      mkdir: 'create directory',
      stat: 'get stats for',
      exists: 'check existence of'
    };

    const verb = operationVerbs[operation] || 'operate on';
    return `Failed to ${verb} ${path}: ${error}`;
  }
}
