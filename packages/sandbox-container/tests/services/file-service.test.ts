import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type { ServiceResult } from '@sandbox-container/core/types';
import {
  FileService,
  type SecurityService
} from '@sandbox-container/services/file-service';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { RawExecResult } from '@sandbox-container/session';
import { mocked } from '../test-utils';

// Mock SecurityService with proper typing
const mockSecurityService: SecurityService = {
  validatePath: vi.fn()
};

// Mock Logger with proper typing
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

// Mock SessionManager with proper typing
const mockSessionManager = {
  executeInSession: vi.fn(),
  executeStreamInSession: vi.fn(),
  killCommand: vi.fn(),
  setEnvVars: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  destroy: vi.fn()
} as unknown as SessionManager;

describe('FileService', () => {
  let fileService: FileService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Set up default successful security validation
    mocked(mockSecurityService.validatePath).mockReturnValue({
      isValid: true,
      errors: []
    });

    // Create service with mocked SessionManager
    fileService = new FileService(
      mockSecurityService,
      mockLogger,
      mockSessionManager
    );
  });

  describe('read', () => {
    // Helper to setup common mocks for read operations
    function setupReadMocks(
      fileSize: number,
      mimeType: string,
      commandOutput: string
    ) {
      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: fileSize.toString(), stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock MIME type detection
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: mimeType, stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock file read command (base64 or cat)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: commandOutput, stderr: '' }
      } as ServiceResult<RawExecResult>);
    }

    it('should read text file with MIME type detection', async () => {
      const testPath = '/tmp/test.txt';
      const testContent = 'Hello, World!';

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command (file size)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '13', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock MIME type detection
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'text/plain', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock cat command for text file
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: testContent, stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read(testPath, {}, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(testContent);
        expect(result.metadata?.encoding).toBe('utf-8');
        expect(result.metadata?.isBinary).toBe(false);
        expect(result.metadata?.mimeType).toBe('text/plain');
        expect(result.metadata?.size).toBe(13);
      }

      // Verify security validation was called
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith(testPath);

      // Verify MIME type detection command was called
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "file --mime-type -b '/tmp/test.txt'"
      );

      // Verify cat was called for text file
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "cat '/tmp/test.txt'"
      );
    });

    it('should read binary file with base64 encoding', async () => {
      const testPath = '/tmp/image.png';
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const base64Content = binaryData.toString('base64');

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command (file size)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '1024', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock MIME type detection - PNG image
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'image/png', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock base64 command for binary file
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: base64Content, stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read(testPath, {}, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(base64Content);
        expect(result.metadata?.encoding).toBe('base64');
        expect(result.metadata?.isBinary).toBe(true);
        expect(result.metadata?.mimeType).toBe('image/png');
        expect(result.metadata?.size).toBe(1024);
      }

      // Verify base64 command was called for binary file
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "base64 -w 0 < '/tmp/image.png'"
      );
    });

    it('should detect JSON files as text', async () => {
      const testPath = '/tmp/config.json';
      const testContent = '{"key": "value"}';

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '17', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock MIME type detection - JSON
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'application/json', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock cat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: testContent, stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read(testPath, {}, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(testContent);
        expect(result.metadata?.encoding).toBe('utf-8');
        expect(result.metadata?.isBinary).toBe(false);
        expect(result.metadata?.mimeType).toBe('application/json');
      }
    });

    it('should detect JavaScript files as text', async () => {
      const testPath = '/tmp/script.js';
      const testContent = 'console.log("test");';

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '20', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock MIME type detection - JavaScript
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'text/javascript', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock cat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: testContent, stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read(testPath, {}, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(testContent);
        expect(result.metadata?.encoding).toBe('utf-8');
        expect(result.metadata?.isBinary).toBe(false);
      }
    });

    it('should return error when security validation fails', async () => {
      mocked(mockSecurityService.validatePath).mockReturnValue({
        isValid: false,
        errors: ['Path contains invalid characters', 'Path outside sandbox']
      });

      const result = await fileService.read('/malicious/../path');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain(
          'Path contains invalid characters'
        );
      }

      // Should not attempt file operations
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should return error when file does not exist', async () => {
      // Mock exists check returning false
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 1, // test -e returns 1 when file doesn't exist
          stdout: '',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should handle stat command errors', async () => {
      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command failure
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'Permission denied' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });

    it('should handle MIME type detection errors gracefully', async () => {
      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '100', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock MIME type detection failure
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'Cannot detect MIME type' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });

    it('should handle read command errors', async () => {
      // Mock exists check success
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      // Mock read command failure
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: {
          exitCode: 1,
          stdout: '',
          stderr: 'Permission denied'
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });

    it('should force base64 encoding when explicitly requested', async () => {
      const testPath = '/tmp/text.txt';
      const testContent = 'Hello World';
      const base64Content = Buffer.from(testContent).toString('base64');

      setupReadMocks(11, 'text/plain', base64Content);

      const result = await fileService.read(
        testPath,
        { encoding: 'base64' },
        'session-123'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(base64Content);
        expect(result.metadata?.encoding).toBe('base64');
        expect(result.metadata?.isBinary).toBe(true);
        expect(result.metadata?.mimeType).toBe('text/plain');
      }

      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "base64 -w 0 < '/tmp/text.txt'"
      );
    });

    it('should force utf-8 encoding when explicitly requested', async () => {
      const testPath = '/tmp/data.bin';
      const testContent = 'Some text content';

      setupReadMocks(17, 'application/octet-stream', testContent);

      const result = await fileService.read(
        testPath,
        { encoding: 'utf-8' },
        'session-123'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(testContent);
        expect(result.metadata?.encoding).toBe('utf-8');
        expect(result.metadata?.isBinary).toBe(false);
        expect(result.metadata?.mimeType).toBe('application/octet-stream');
      }

      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "cat '/tmp/data.bin'"
      );

      // Also test 'utf8' alias works the same way
      vi.clearAllMocks();
      setupReadMocks(17, 'application/octet-stream', testContent);

      const aliasResult = await fileService.read(
        testPath,
        { encoding: 'utf8' },
        'session-123'
      );

      expect(aliasResult.success).toBe(true);
      if (!aliasResult.success) throw new Error('Expected success');
      expect(aliasResult.metadata?.encoding).toBe('utf-8');
    });

    it('should use MIME-based detection when no encoding specified', async () => {
      const testPath = '/tmp/auto.json';
      const testContent = '{"key": "value"}';

      setupReadMocks(16, 'application/json', testContent);

      const result = await fileService.read(testPath, {}, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(testContent);
        expect(result.metadata?.encoding).toBe('utf-8');
        expect(result.metadata?.isBinary).toBe(false);
      }
    });
  });

  describe('write', () => {
    it('should write file successfully with base64 encoding', async () => {
      const testPath = '/tmp/test.txt';
      const testContent = 'Test content';
      const base64Content = Buffer.from(testContent, 'utf-8').toString(
        'base64'
      );

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.write(
        testPath,
        testContent,
        {},
        'session-123'
      );

      expect(result.success).toBe(true);

      // Verify SessionManager was called with base64 encoded content
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        `printf '%s' '${base64Content}' | base64 -d > '/tmp/test.txt'`
      );
    });

    it('should support utf8 as alias for utf-8 encoding in write', async () => {
      const testPath = '/tmp/test.txt';
      const testContent = 'Test content';
      const base64Content = Buffer.from(testContent, 'utf-8').toString(
        'base64'
      );

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.write(
        testPath,
        testContent,
        { encoding: 'utf8' },
        'session-123'
      );

      expect(result.success).toBe(true);

      // Verify text encoding path is used (printf + base64)
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        `printf '%s' '${base64Content}' | base64 -d > '/tmp/test.txt'`
      );
    });

    it('should write binary file with base64 encoding option', async () => {
      const testPath = '/tmp/image.png';
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const base64Content = binaryData.toString('base64');

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.write(
        testPath,
        base64Content,
        { encoding: 'base64' },
        'session-123'
      );

      expect(result.success).toBe(true);

      // Verify that content is passed directly without re-encoding
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        `printf '%s' '${base64Content}' | base64 -d > '/tmp/image.png'`
      );
    });

    it('should reject base64 content with invalid characters', async () => {
      const testPath = '/tmp/test.txt';

      const maliciousInputs = [
        "abc'; rm -rf / #", // Shell command injection
        'valid$(whoami)base64', // Command substitution
        'test\nmalicious', // Newline injection
        'test`whoami`test', // Backtick injection
        'test|whoami', // Pipe injection
        'test&whoami&' // Background command injection
      ];

      for (const maliciousContent of maliciousInputs) {
        vi.clearAllMocks();

        const result = await fileService.write(
          testPath,
          maliciousContent,
          { encoding: 'base64' },
          'session-123'
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error('Expected failure');
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
      }
    });

    it('should accept valid base64 content with padding', async () => {
      const testPath = '/tmp/test.txt';
      const validBase64 = 'SGVsbG8gV29ybGQ='; // "Hello World" with padding

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 0,
          stdout: '',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.write(
        testPath,
        validBase64,
        { encoding: 'base64' },
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(mockSessionManager.executeInSession).toHaveBeenCalled();
    });

    it('should handle write errors', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: {
          exitCode: 1,
          stdout: '',
          stderr: 'Disk full'
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.write('/tmp/test.txt', 'content');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });
  });

  describe('delete', () => {
    it('should delete file successfully', async () => {
      const testPath = '/tmp/test.txt';

      // delete() calls:
      // 1. exists() - 1 call
      // 2. stat() which internally calls exists() again + stat command - 2 calls
      // 3. rm command - 1 call
      // Total: 4 calls

      // Mock first exists check (from delete)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock second exists check (from stat)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command (to verify it's not a directory)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: {
          exitCode: 0,
          stdout: 'regular file:100:1234567890:1234567890\n',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      // Mock delete command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.delete(testPath, 'session-123');

      expect(result.success).toBe(true);

      // Verify rm command was called (cwd is undefined, so only 2 params)
      // Should be the 4th call
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        4,
        'session-123',
        "rm '/tmp/test.txt'"
      );
    });

    it('should return error when file does not exist', async () => {
      // Mock exists check returning false
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.delete('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should handle delete command failures', async () => {
      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: {
          exitCode: 0,
          stdout: 'regular file:100:1234567890:1234567890\n',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      // Mock delete command failure
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'Permission denied' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.delete('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });
  });

  describe('rename', () => {
    it('should rename file successfully', async () => {
      const oldPath = '/tmp/old.txt';
      const newPath = '/tmp/new.txt';

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock rename command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.rename(oldPath, newPath, 'session-123');

      expect(result.success).toBe(true);

      // Should validate both paths
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith(oldPath);
      expect(mockSecurityService.validatePath).toHaveBeenCalledWith(newPath);

      // Verify mv command was called (cwd is undefined, so only 2 params)
      // Should be the 2nd call after exists
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        2,
        'session-123',
        "mv '/tmp/old.txt' '/tmp/new.txt'"
      );
    });

    it('should handle rename command failures', async () => {
      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock rename failure
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'Target exists' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.rename('/tmp/old.txt', '/tmp/new.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });
  });

  describe('move', () => {
    it('should move file using atomic mv operation', async () => {
      const sourcePath = '/tmp/source.txt';
      const destPath = '/tmp/dest.txt';

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock move command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.move(
        sourcePath,
        destPath,
        'session-123'
      );

      expect(result.success).toBe(true);

      // Verify mv command was called (cwd is undefined, so only 2 params)
      // Should be the 2nd call after exists
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        2,
        'session-123',
        "mv '/tmp/source.txt' '/tmp/dest.txt'"
      );
    });

    it('should return error when source does not exist', async () => {
      // Mock exists check returning false
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.move(
        '/tmp/nonexistent.txt',
        '/tmp/dest.txt'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });
  });

  describe('mkdir', () => {
    it('should create directory successfully', async () => {
      const testPath = '/tmp/newdir';

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.mkdir(testPath, {}, 'session-123');

      expect(result.success).toBe(true);

      // Verify mkdir command was called (cwd is undefined, so only 2 params)
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "mkdir '/tmp/newdir'"
      );
    });

    it('should create directory recursively when requested', async () => {
      const testPath = '/tmp/nested/dir';

      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.mkdir(
        testPath,
        { recursive: true },
        'session-123'
      );

      expect(result.success).toBe(true);

      // Verify mkdir -p command was called (cwd is undefined, so only 2 params)
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "mkdir -p '/tmp/nested/dir'"
      );
    });

    it('should handle mkdir command failures', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'Parent directory not found' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.mkdir('/tmp/newdir');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.exists('/tmp/test.txt', 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(true);
      }

      // Verify test -e command was called (cwd is undefined, so only 2 params)
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "test -e '/tmp/test.txt'"
      );
    });

    it('should return false when file does not exist', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.exists('/tmp/nonexistent.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });

    it('should handle execution failures gracefully', async () => {
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: false,
        error: {
          message: 'Session error',
          code: 'SESSION_ERROR'
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.exists('/tmp/test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });
  });

  describe('stat', () => {
    it('should return file statistics successfully', async () => {
      const testPath = '/tmp/test.txt';

      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: {
          exitCode: 0,
          stdout: 'regular file:1024:1672531200:1672531100\n',
          stderr: ''
        }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.stat(testPath, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isFile).toBe(true);
        expect(result.data.isDirectory).toBe(false);
        expect(result.data.size).toBe(1024);
        expect(result.data.modified).toBeInstanceOf(Date);
        expect(result.data.created).toBeInstanceOf(Date);
      }
    });

    it('should return error when file does not exist', async () => {
      // Mock exists check returning false
      mocked(mockSessionManager.executeInSession).mockResolvedValue({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.stat('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should handle stat command failures', async () => {
      // Mock exists check
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock stat command failure
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'stat error' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.stat('/tmp/test.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILESYSTEM_ERROR');
      }
    });
  });
});
