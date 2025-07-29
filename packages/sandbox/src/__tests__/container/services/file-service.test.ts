/**
 * File Service Tests
 * 
 * Tests the FileService class from the refactored container architecture.
 * Demonstrates testing services with security integration and Bun APIs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FileService, SecurityService } from '@container/services/file-service';
import type { Logger, FileStats } from '@container/core/types';

// Mock the dependencies
const mockSecurityService: SecurityService = {
  validatePath: vi.fn(),
  sanitizePath: vi.fn(),
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock Bun globals for testing
const mockBunFile = {
  exists: vi.fn(),
  text: vi.fn(),
};

const mockBunWrite = vi.fn();
const mockBunSpawn = vi.fn();

// Mock Bun global functions
global.Bun = {
  file: vi.fn(() => mockBunFile),
  write: mockBunWrite,
  spawn: mockBunSpawn,
} as any;

// Mock Response for stream reading
global.Response = vi.fn().mockImplementation((stream) => ({
  text: vi.fn().mockResolvedValue('regular file:1024:1672531200:1672531200'),
})) as any;

describe('FileService', () => {
  let fileService: FileService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Set up default successful security validation
    (mockSecurityService.validatePath as any).mockReturnValue({
      isValid: true,
      errors: []
    });

    // Import the FileService (dynamic import)
    const { FileService: FileServiceClass } = await import('@container/services/file-service');
    fileService = new FileServiceClass(mockSecurityService, mockLogger);
  });

  describe('read', () => {
    it('should read file successfully when valid path and file exists', async () => {
      const testContent = 'Hello, World!';
      mockBunFile.exists.mockResolvedValue(true);
      mockBunFile.text.mockResolvedValue(testContent);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(testContent);
      }

      // Verify security validation was called
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/test.txt');
      
      // Verify Bun APIs were called correctly
      expect(global.Bun.file).toHaveBeenCalledWith('/tmp/test.txt');
      expect(mockBunFile.exists).toHaveBeenCalled();
      expect(mockBunFile.text).toHaveBeenCalled();

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reading file', 
        { path: '/tmp/test.txt', encoding: undefined }
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File read successfully',
        { path: '/tmp/test.txt', sizeBytes: testContent.length }
      );
    });

    it('should return error when security validation fails', async () => {
      (mockSecurityService.validatePath as any).mockReturnValue({
        isValid: false,
        errors: ['Path contains invalid characters', 'Path outside sandbox']
      });

      const result = await fileService.read('/malicious/../path');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SECURITY_VALIDATION_FAILED');
        expect(result.error.message).toContain('Path contains invalid characters');
        expect(result.error.details?.errors).toEqual([
          'Path contains invalid characters', 
          'Path outside sandbox'
        ]);
      }

      // Should not attempt file operations
      expect(global.Bun.file).not.toHaveBeenCalled();
    });

    it('should return error when file does not exist', async () => {
      mockBunFile.exists.mockResolvedValue(false);

      const result = await fileService.read('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
        expect(result.error.message).toBe('File not found: /tmp/nonexistent.txt');
        expect(result.error.details?.path).toBe('/tmp/nonexistent.txt');
      }
    });

    it('should handle Bun API errors gracefully', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const bunError = new Error('Permission denied');
      mockBunFile.text.mockRejectedValue(bunError);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_READ_ERROR');
        expect(result.error.message).toContain('Permission denied');
        expect(result.error.details?.originalError).toBe('Permission denied');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to read file',
        bunError,
        { path: '/tmp/test.txt' }
      );
    });
  });

  describe('write', () => {
    it('should write file successfully', async () => {
      const testContent = 'Test content';
      mockBunWrite.mockResolvedValue(undefined);

      const result = await fileService.write('/tmp/test.txt', testContent);

      expect(result.success).toBe(true);
      
      // Verify Bun.write was called correctly
      expect(mockBunWrite).toHaveBeenCalledWith('/tmp/test.txt', testContent);

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Writing file',
        { path: '/tmp/test.txt', sizeBytes: testContent.length, encoding: undefined }
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File written successfully',
        { path: '/tmp/test.txt', sizeBytes: testContent.length }
      );
    });

    it('should handle write errors', async () => {
      const writeError = new Error('Disk full');
      mockBunWrite.mockRejectedValue(writeError);

      const result = await fileService.write('/tmp/test.txt', 'content');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_WRITE_ERROR');
        expect(result.error.details?.originalError).toBe('Disk full');
      }
    });
  });

  describe('delete', () => {
    it('should delete file successfully when it exists', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const mockProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.delete('/tmp/test.txt');

      expect(result.success).toBe(true);
      expect(mockBunSpawn).toHaveBeenCalledWith(['rm', '/tmp/test.txt']);
      expect(mockLogger.info).toHaveBeenCalledWith('File deleted successfully', { path: '/tmp/test.txt' });
    });

    it('should return error when file does not exist', async () => {
      mockBunFile.exists.mockResolvedValue(false);

      const result = await fileService.delete('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }

      // Should not attempt to delete
      expect(mockBunSpawn).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('should rename file successfully', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const mockProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.rename('/tmp/old.txt', '/tmp/new.txt');

      expect(result.success).toBe(true);
      
      // Should validate both paths
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/old.txt');
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith('/tmp/new.txt');
      
      // Should use mv command
      expect(mockBunSpawn).toHaveBeenCalledWith(['mv', '/tmp/old.txt', '/tmp/new.txt']);
    });

    it('should handle rename command failures', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const mockProcess = { exited: Promise.resolve(), exitCode: 1 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.rename('/tmp/old.txt', '/tmp/new.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RENAME_ERROR');
        expect(result.error.details?.exitCode).toBe(1);
      }
    });

    it('should validate both old and new paths', async () => {
      (mockSecurityService.validatePath as any)
        .mockReturnValueOnce({ isValid: true, errors: [] })   // old path valid
        .mockReturnValueOnce({ isValid: false, errors: ['Invalid new path'] }); // new path invalid

      const result = await fileService.rename('/tmp/old.txt', '/invalid/new.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SECURITY_VALIDATION_FAILED');
        expect(result.error.details?.errors).toContain('Invalid new path');
      }
    });
  });

  describe('move', () => {
    it('should move file using zero-copy operations', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      mockBunWrite.mockResolvedValue(undefined);
      const mockDeleteProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockDeleteProcess);

      const result = await fileService.move('/tmp/source.txt', '/tmp/dest.txt');

      expect(result.success).toBe(true);
      
      // Should use Bun.write for zero-copy operation
      expect(mockBunWrite).toHaveBeenCalledWith('/tmp/dest.txt', mockBunFile);
      
      // Should remove source file
      expect(mockBunSpawn).toHaveBeenCalledWith(['rm', '/tmp/source.txt']);
    });

    it('should return error when source does not exist', async () => {
      mockBunFile.exists.mockResolvedValue(false);

      const result = await fileService.move('/tmp/nonexistent.txt', '/tmp/dest.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });
  });

  describe('mkdir', () => {
    it('should create directory successfully', async () => {
      const mockProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.mkdir('/tmp/newdir');

      expect(result.success).toBe(true);
      expect(mockBunSpawn).toHaveBeenCalledWith(['mkdir', '/tmp/newdir']);
    });

    it('should create directory recursively when requested', async () => {
      const mockProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.mkdir('/tmp/nested/dir', { recursive: true });

      expect(result.success).toBe(true);
      expect(mockBunSpawn).toHaveBeenCalledWith(['mkdir', '-p', '/tmp/nested/dir']);
    });

    it('should handle mkdir command failures', async () => {
      const mockProcess = { exited: Promise.resolve(), exitCode: 1 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.mkdir('/tmp/newdir');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('MKDIR_ERROR');
        expect(result.error.details?.exitCode).toBe(1);
      }
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      mockBunFile.exists.mockResolvedValue(true);

      const result = await fileService.exists('/tmp/test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(true);
      }
    });

    it('should return false when file does not exist', async () => {
      mockBunFile.exists.mockResolvedValue(false);

      const result = await fileService.exists('/tmp/nonexistent.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });

    it('should handle exists check errors', async () => {
      const existsError = new Error('Permission denied');
      mockBunFile.exists.mockRejectedValue(existsError);

      const result = await fileService.exists('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('EXISTS_ERROR');
      }

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error checking file existence',
        { path: '/tmp/test.txt', error: 'Permission denied' }
      );
    });
  });

  describe('stat', () => {
    it('should return file statistics successfully', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const mockProcess = {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('regular file:1024:1672531200:1672531100'));
            controller.close();
          }
        })
      };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.stat('/tmp/test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isFile).toBe(true);
        expect(result.data.isDirectory).toBe(false);
        expect(result.data.size).toBe(1024);
        expect(result.data.modified).toBeInstanceOf(Date);
        expect(result.data.created).toBeInstanceOf(Date);
      }

      expect(mockBunSpawn).toHaveBeenCalledWith(
        ['stat', '-c', '%F:%s:%Y:%W', '/tmp/test.txt'],
        { stdout: 'pipe' }
      );
    });

    it('should return error when file does not exist', async () => {
      mockBunFile.exists.mockResolvedValue(false);

      const result = await fileService.stat('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should handle stat command failures', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const mockProcess = { exited: Promise.resolve(), exitCode: 1, stdout: null };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.stat('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('STAT_ERROR');
        expect(result.error.details?.exitCode).toBe(1);
      }
    });
  });

  describe('convenience methods', () => {
    it('should provide readFile wrapper', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      mockBunFile.text.mockResolvedValue('content');

      const result = await fileService.readFile('/tmp/test.txt');

      expect(result.success).toBe(true);
      expect(global.Bun.file).toHaveBeenCalledWith('/tmp/test.txt');
    });

    it('should provide writeFile wrapper', async () => {
      mockBunWrite.mockResolvedValue(undefined);

      const result = await fileService.writeFile('/tmp/test.txt', 'content');

      expect(result.success).toBe(true);
      expect(mockBunWrite).toHaveBeenCalledWith('/tmp/test.txt', 'content');
    });

    it('should provide deleteFile wrapper', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      const mockProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockProcess);

      const result = await fileService.deleteFile('/tmp/test.txt');

      expect(result.success).toBe(true);
      expect(mockBunSpawn).toHaveBeenCalledWith(['rm', '/tmp/test.txt']);
    });

    // Test other convenience wrappers
    it('should provide all convenience method wrappers', async () => {
      // Mock successful operations for all wrapper methods
      mockBunFile.exists.mockResolvedValue(true);
      mockBunWrite.mockResolvedValue(undefined);
      const mockProcess = { exited: Promise.resolve(), exitCode: 0 };
      mockBunSpawn.mockReturnValue(mockProcess);

      // Test renameFile
      const renameResult = await fileService.renameFile('/old.txt', '/new.txt');
      expect(renameResult.success).toBe(true);

      // Test moveFile
      const moveResult = await fileService.moveFile('/src.txt', '/dst.txt');
      expect(moveResult.success).toBe(true);

      // Test createDirectory
      const mkdirResult = await fileService.createDirectory('/tmp/dir');
      expect(mkdirResult.success).toBe(true);

      // Test getFileStats
      mockBunSpawn.mockReturnValue({
        ...mockProcess,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('directory:4096:1672531200:1672531100'));
            controller.close();
          }
        })
      });
      const statResult = await fileService.getFileStats('/tmp/dir');
      expect(statResult.success).toBe(true);
    });
  });

  describe('error handling patterns', () => {
    it('should handle non-Error exceptions consistently', async () => {
      mockBunFile.exists.mockResolvedValue(true);
      mockBunFile.text.mockRejectedValue('String error');

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.originalError).toBe('Unknown error');
      }
    });

    it('should include proper context in all error responses', async () => {
      const testPath = '/tmp/test.txt';
      mockBunFile.exists.mockResolvedValue(false);

      const result = await fileService.read(testPath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.path).toBe(testPath);
        expect(result.error.message).toContain(testPath);
      }
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored FileService:
 * 
 * 1. **Security Integration Testing**: FileService integrates with SecurityService
 *    for path validation, and we test this integration through mocking.
 * 
 * 2. **Bun API Mocking**: The service uses Bun.file(), Bun.write(), and Bun.spawn()
 *    for performance. We mock these globals to test the service logic.
 * 
 * 3. **ServiceResult Pattern**: All methods return ServiceResult<T>, enabling
 *    consistent testing of success/error scenarios.
 * 
 * 4. **System Command Integration**: The service uses system commands (rm, mv, mkdir, stat)
 *    via Bun.spawn(), and we test both success and failure cases.
 * 
 * 5. **Comprehensive Error Scenarios**: Tests cover security failures, file not found,
 *    permission errors, command failures, and various edge cases.
 * 
 * 6. **Performance Optimization Testing**: Tests validate that zero-copy operations
 *    and Bun-native APIs are used correctly.
 * 
 * 7. **Convenience Method Coverage**: Tests ensure wrapper methods work correctly
 *    and provide the same functionality as core methods.
 */