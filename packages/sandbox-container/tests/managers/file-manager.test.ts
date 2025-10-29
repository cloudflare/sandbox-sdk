import { beforeEach, describe, expect, it } from 'bun:test';
import type { FileStats } from '@sandbox-container/core/types.ts';
import { FileManager } from '@sandbox-container/managers/file-manager.ts';

describe('FileManager', () => {
  let manager: FileManager;

  beforeEach(() => {
    manager = new FileManager();
  });

  describe('parseStatOutput', () => {
    it('should parse regular file stats correctly', () => {
      const output = 'regular file:1024:1672531200:1672531100';
      const stats = manager.parseStatOutput(output);

      expect(stats.isFile).toBe(true);
      expect(stats.isDirectory).toBe(false);
      expect(stats.size).toBe(1024);
      expect(stats.modified).toEqual(new Date(1672531200 * 1000));
      expect(stats.created).toEqual(new Date(1672531100 * 1000));
    });

    it('should parse directory stats correctly', () => {
      const output = 'directory:4096:1672531200:1672531100';
      const stats = manager.parseStatOutput(output);

      expect(stats.isFile).toBe(false);
      expect(stats.isDirectory).toBe(true);
      expect(stats.size).toBe(4096);
    });

    it('should handle zero-byte files', () => {
      const output = 'regular file:0:1672531200:1672531100';
      const stats = manager.parseStatOutput(output);

      expect(stats.size).toBe(0);
      expect(stats.isFile).toBe(true);
    });

    it('should handle large files', () => {
      const largeSize = 9999999999;
      const output = `regular file:${largeSize}:1672531200:1672531100`;
      const stats = manager.parseStatOutput(output);

      expect(stats.size).toBe(largeSize);
    });

    it('should throw error for invalid format - too few parts', () => {
      const output = 'regular file:1024';

      expect(() => manager.parseStatOutput(output)).toThrow(
        'Invalid stat output format'
      );
      expect(() => manager.parseStatOutput(output)).toThrow(
        'expected 4 parts, got 2'
      );
    });

    it('should throw error for empty output', () => {
      expect(() => manager.parseStatOutput('')).toThrow(
        'Invalid stat output format'
      );
    });

    it('should parse BSD stat format (macOS) correctly', () => {
      // BSD stat uses capitalized type names
      const output = 'Regular File:1024:1672531200:1672531100';
      const stats = manager.parseStatOutput(output);

      expect(stats.isFile).toBe(true);
      expect(stats.isDirectory).toBe(false);
      expect(stats.size).toBe(1024);
    });

    it('should parse BSD directory format correctly', () => {
      const output = 'Directory:4096:1672531200:1672531100';
      const stats = manager.parseStatOutput(output);

      expect(stats.isFile).toBe(false);
      expect(stats.isDirectory).toBe(true);
      expect(stats.size).toBe(4096);
    });
  });

  describe('buildMkdirArgs', () => {
    it('should build basic mkdir args', () => {
      const args = manager.buildMkdirArgs('/tmp/testdir');

      expect(args).toEqual(['mkdir', '/tmp/testdir']);
    });

    it('should include -p flag for recursive option', () => {
      const args = manager.buildMkdirArgs('/tmp/nested/testdir', {
        recursive: true
      });

      expect(args).toEqual(['mkdir', '-p', '/tmp/nested/testdir']);
    });

    it('should not include -p flag when no options provided', () => {
      const args = manager.buildMkdirArgs('/tmp/testdir');

      expect(args).toEqual(['mkdir', '/tmp/testdir']);
    });

    it('should handle paths with spaces', () => {
      const args = manager.buildMkdirArgs('/tmp/test dir', { recursive: true });

      expect(args).toEqual(['mkdir', '-p', '/tmp/test dir']);
    });
  });

  describe('buildStatArgs', () => {
    it('should build stat command with correct format', () => {
      const result = manager.buildStatArgs('/tmp/test.txt');

      expect(result.command).toBe('stat');
      expect(result.args).toEqual(['-c', '%F:%s:%Y:%W', '/tmp/test.txt']);
      expect(result.format).toBe('type:size:modified:created');
    });
  });

  describe('determineErrorCode', () => {
    it('should return FILE_NOT_FOUND for not found errors', () => {
      expect(
        manager.determineErrorCode('read', new Error('File not found'))
      ).toBe('FILE_NOT_FOUND');
      expect(
        manager.determineErrorCode('read', new Error('ENOENT: no such file'))
      ).toBe('FILE_NOT_FOUND');
      expect(manager.determineErrorCode('read', 'not found')).toBe(
        'FILE_NOT_FOUND'
      );
    });

    it('should return PERMISSION_DENIED for permission errors', () => {
      expect(
        manager.determineErrorCode('read', new Error('Permission denied'))
      ).toBe('PERMISSION_DENIED');
      expect(
        manager.determineErrorCode(
          'write',
          new Error('EACCES: permission denied')
        )
      ).toBe('PERMISSION_DENIED');
    });

    it('should return FILE_EXISTS for file exists errors', () => {
      expect(
        manager.determineErrorCode('write', new Error('File exists'))
      ).toBe('FILE_EXISTS');
      expect(
        manager.determineErrorCode(
          'mkdir',
          new Error('EEXIST: file already exists')
        )
      ).toBe('FILE_EXISTS');
    });

    it('should return DISK_FULL for disk space errors', () => {
      expect(manager.determineErrorCode('write', new Error('Disk full'))).toBe(
        'DISK_FULL'
      );
      expect(
        manager.determineErrorCode('write', new Error('ENOSPC: no space left'))
      ).toBe('DISK_FULL');
    });

    it('should return DIR_NOT_EMPTY for directory not empty errors', () => {
      expect(
        manager.determineErrorCode('delete', new Error('Directory not empty'))
      ).toBe('DIR_NOT_EMPTY');
      expect(
        manager.determineErrorCode(
          'delete',
          new Error('ENOTEMPTY: directory not empty')
        )
      ).toBe('DIR_NOT_EMPTY');
    });

    it('should return operation-specific error codes as fallback', () => {
      expect(
        manager.determineErrorCode('read', new Error('Unknown error'))
      ).toBe('FILE_READ_ERROR');
      expect(
        manager.determineErrorCode('write', new Error('Unknown error'))
      ).toBe('FILE_WRITE_ERROR');
      expect(
        manager.determineErrorCode('delete', new Error('Unknown error'))
      ).toBe('FILE_DELETE_ERROR');
      expect(
        manager.determineErrorCode('rename', new Error('Unknown error'))
      ).toBe('RENAME_ERROR');
      expect(
        manager.determineErrorCode('move', new Error('Unknown error'))
      ).toBe('MOVE_ERROR');
      expect(
        manager.determineErrorCode('mkdir', new Error('Unknown error'))
      ).toBe('MKDIR_ERROR');
      expect(
        manager.determineErrorCode('stat', new Error('Unknown error'))
      ).toBe('STAT_ERROR');
      expect(
        manager.determineErrorCode('exists', new Error('Unknown error'))
      ).toBe('EXISTS_ERROR');
    });

    it('should return generic code for unknown operations', () => {
      expect(manager.determineErrorCode('unknown', new Error('Error'))).toBe(
        'FILE_OPERATION_ERROR'
      );
    });
  });

  describe('validateStats', () => {
    it('should validate correct stats', () => {
      const stats: FileStats = {
        isFile: true,
        isDirectory: false,
        size: 1024,
        modified: new Date('2024-01-01T00:00:00Z'),
        created: new Date('2024-01-01T00:00:00Z')
      };

      const result = manager.validateStats(stats);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject negative file size', () => {
      const stats: FileStats = {
        isFile: true,
        isDirectory: false,
        size: -1,
        modified: new Date('2024-01-01'),
        created: new Date('2024-01-01')
      };

      const result = manager.validateStats(stats);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('File size cannot be negative');
    });

    it('should reject oversized file sizes', () => {
      const stats: FileStats = {
        isFile: true,
        isDirectory: false,
        size: Number.MAX_SAFE_INTEGER + 1,
        modified: new Date('2024-01-01'),
        created: new Date('2024-01-01')
      };

      const result = manager.validateStats(stats);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('File size exceeds maximum safe integer');
    });

    it('should reject dates before Unix epoch', () => {
      const stats: FileStats = {
        isFile: true,
        isDirectory: false,
        size: 1024,
        modified: new Date('1969-01-01'),
        created: new Date('2024-01-01')
      };

      const result = manager.validateStats(stats);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Modified date cannot be before Unix epoch'
      );
    });

    it('should handle zero-size files', () => {
      const stats: FileStats = {
        isFile: true,
        isDirectory: false,
        size: 0,
        modified: new Date('2024-01-01'),
        created: new Date('2024-01-01')
      };

      const result = manager.validateStats(stats);

      expect(result.valid).toBe(true);
    });
  });

  describe('planOperation', () => {
    it('should plan read operation', () => {
      const plan = manager.planOperation('read', '/tmp/test.txt');

      expect(plan.operation).toBe('read');
      expect(plan.paths).toEqual(['/tmp/test.txt']);
      expect(plan.requiresCheck).toBe(true);
    });

    it('should plan write operation', () => {
      const plan = manager.planOperation('write', '/tmp/test.txt');

      expect(plan.operation).toBe('write');
      expect(plan.paths).toEqual(['/tmp/test.txt']);
      expect(plan.requiresCheck).toBe(false);
    });

    it('should plan delete operation with command', () => {
      const plan = manager.planOperation('delete', '/tmp/test.txt');

      expect(plan.operation).toBe('delete');
      expect(plan.paths).toEqual(['/tmp/test.txt']);
      expect(plan.requiresCheck).toBe(true);
      expect(plan.command).toEqual({
        executable: 'rm',
        args: ['/tmp/test.txt']
      });
    });

    it('should plan rename operation with command', () => {
      const plan = manager.planOperation(
        'rename',
        '/tmp/old.txt',
        '/tmp/new.txt'
      );

      expect(plan.operation).toBe('rename');
      expect(plan.paths).toEqual(['/tmp/old.txt', '/tmp/new.txt']);
      expect(plan.requiresCheck).toBe(true);
      expect(plan.command).toEqual({
        executable: 'mv',
        args: ['/tmp/old.txt', '/tmp/new.txt']
      });
    });

    it('should plan move operation', () => {
      const plan = manager.planOperation(
        'move',
        '/tmp/src.txt',
        '/tmp/dst.txt'
      );

      expect(plan.operation).toBe('move');
      expect(plan.paths).toEqual(['/tmp/src.txt', '/tmp/dst.txt']);
      expect(plan.requiresCheck).toBe(true);
    });

    it('should plan mkdir operation', () => {
      const plan = manager.planOperation('mkdir', '/tmp/newdir');

      expect(plan.operation).toBe('mkdir');
      expect(plan.paths).toEqual(['/tmp/newdir']);
      expect(plan.requiresCheck).toBe(false);
    });

    it('should plan stat operation', () => {
      const plan = manager.planOperation('stat', '/tmp/test.txt');

      expect(plan.operation).toBe('stat');
      expect(plan.paths).toEqual(['/tmp/test.txt']);
      expect(plan.requiresCheck).toBe(true);
    });

    it('should throw error for unknown operation', () => {
      expect(() => manager.planOperation('invalid', '/tmp/test.txt')).toThrow(
        'Unknown operation: invalid'
      );
    });
  });

  describe('shouldUseMoveCommand', () => {
    it('should return true for paths in same filesystem', () => {
      expect(
        manager.shouldUseMoveCommand('/tmp/source.txt', '/tmp/dest.txt')
      ).toBe(true);
      expect(
        manager.shouldUseMoveCommand('/home/user/a.txt', '/home/user/b.txt')
      ).toBe(true);
      expect(manager.shouldUseMoveCommand('/workspace/a', '/workspace/b')).toBe(
        true
      );
    });

    it('should return false for paths across different filesystems', () => {
      expect(
        manager.shouldUseMoveCommand('/tmp/source.txt', '/home/dest.txt')
      ).toBe(false);
      expect(
        manager.shouldUseMoveCommand('/home/a.txt', '/workspace/b.txt')
      ).toBe(false);
    });

    it('should handle nested paths correctly', () => {
      expect(
        manager.shouldUseMoveCommand(
          '/tmp/nested/dir/file.txt',
          '/tmp/other/file.txt'
        )
      ).toBe(true);
      expect(
        manager.shouldUseMoveCommand(
          '/home/user/deep/nested/a.txt',
          '/workspace/b.txt'
        )
      ).toBe(false);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(manager.formatFileSize(0)).toBe('0 B');
      expect(manager.formatFileSize(100)).toBe('100 B');
      expect(manager.formatFileSize(1023)).toBe('1023 B');
    });

    it('should format kilobytes correctly', () => {
      expect(manager.formatFileSize(1024)).toBe('1 KB');
      expect(manager.formatFileSize(1536)).toBe('1.5 KB');
      expect(manager.formatFileSize(10240)).toBe('10 KB');
    });

    it('should format megabytes correctly', () => {
      expect(manager.formatFileSize(1048576)).toBe('1 MB');
      expect(manager.formatFileSize(1572864)).toBe('1.5 MB');
      expect(manager.formatFileSize(10485760)).toBe('10 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(manager.formatFileSize(1073741824)).toBe('1 GB');
      expect(manager.formatFileSize(1610612736)).toBe('1.5 GB');
    });

    it('should format terabytes correctly', () => {
      expect(manager.formatFileSize(1099511627776)).toBe('1 TB');
    });

    it('should round to 2 decimal places', () => {
      expect(manager.formatFileSize(1536)).toBe('1.5 KB');
      expect(manager.formatFileSize(1234)).toBe('1.21 KB');
      expect(manager.formatFileSize(123456789)).toBe('117.74 MB');
    });
  });

  describe('createErrorMessage', () => {
    it('should create error message for read operation', () => {
      const msg = manager.createErrorMessage(
        'read',
        '/tmp/test.txt',
        'File not found'
      );

      expect(msg).toBe('Failed to read /tmp/test.txt: File not found');
    });

    it('should create error message for write operation', () => {
      const msg = manager.createErrorMessage(
        'write',
        '/tmp/test.txt',
        'Permission denied'
      );

      expect(msg).toBe('Failed to write /tmp/test.txt: Permission denied');
    });

    it('should create error message for delete operation', () => {
      const msg = manager.createErrorMessage(
        'delete',
        '/tmp/test.txt',
        'File is locked'
      );

      expect(msg).toBe('Failed to delete /tmp/test.txt: File is locked');
    });

    it('should create error message for mkdir operation', () => {
      const msg = manager.createErrorMessage(
        'mkdir',
        '/tmp/newdir',
        'Parent directory not found'
      );

      expect(msg).toBe(
        'Failed to create directory /tmp/newdir: Parent directory not found'
      );
    });

    it('should create error message for rename operation', () => {
      const msg = manager.createErrorMessage(
        'rename',
        '/tmp/old.txt',
        'Target exists'
      );

      expect(msg).toBe('Failed to rename /tmp/old.txt: Target exists');
    });

    it('should create error message for stat operation', () => {
      const msg = manager.createErrorMessage(
        'stat',
        '/tmp/test.txt',
        'Invalid file'
      );

      expect(msg).toBe('Failed to get stats for /tmp/test.txt: Invalid file');
    });

    it('should handle unknown operations with generic verb', () => {
      const msg = manager.createErrorMessage(
        'unknown',
        '/tmp/test.txt',
        'Error'
      );

      expect(msg).toBe('Failed to operate on /tmp/test.txt: Error');
    });
  });
});
