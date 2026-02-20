import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  vi
} from 'bun:test';
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
  destroy: vi.fn(),
  withSession: vi.fn()
} as unknown as SessionManager;

interface MockFileOptions {
  exists?: boolean;
  text?: string;
  arrayBuffer?: ArrayBuffer;
  size?: number;
  type?: string;
  stream?: ReadableStream<Uint8Array>;
}

let bunFileSpy: ReturnType<typeof spyOn> | null = null;

const mockBunFile = (options: MockFileOptions = {}) => {
  const {
    exists = true,
    text = '',
    arrayBuffer = new ArrayBuffer(0),
    size = 0,
    type = 'text/plain',
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    })
  } = options;

  bunFileSpy = spyOn(Bun, 'file').mockImplementation((_path) => {
    return {
      exists: async () => exists,
      text: async () => text,
      arrayBuffer: async () => arrayBuffer,
      size,
      type,
      stream: () => stream,
      bytes: async () => new Uint8Array(arrayBuffer)
    } as any;
  });
  return bunFileSpy;
};

describe('FileService', () => {
  let fileService: FileService;

  afterEach(() => {
    bunFileSpy?.mockRestore();
    bunFileSpy = null;
  });

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Set up default successful security validation
    mocked(mockSecurityService.validatePath).mockReturnValue({
      isValid: true,
      errors: []
    });

    // Mock withSession to execute the callback immediately with a mock exec function
    mocked(mockSessionManager.withSession).mockImplementation(
      async (_sessionId, callback) => {
        try {
          const mockExec = async (cmd: string) => {
            // Delegate to executeInSession mock for compatibility with existing tests
            const result = await mockSessionManager.executeInSession(
              _sessionId,
              cmd
            );
            if (result.success) {
              return result.data;
            }
            throw new Error('Command execution failed');
          };
          const data = await callback(mockExec);
          return { success: true, data } as any;
        } catch (error: any) {
          // If error has code/message/details, return it as-is
          if (error && typeof error === 'object' && 'code' in error) {
            return { success: false, error } as any;
          }
          // Otherwise wrap as generic error
          return {
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : 'Unknown error',
              details: {}
            }
          } as any;
        }
      }
    );

    // Create service with mocked SessionManager
    fileService = new FileService(
      mockSecurityService,
      mockLogger,
      mockSessionManager
    );
  });

  describe('read', () => {
    it('should read text file with MIME type detection', async () => {
      const testPath = '/tmp/test.txt';
      const testContent = 'Hello, World!';

      mockBunFile({
        exists: true,
        size: 13,
        type: 'text/plain',
        text: testContent
      });

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

      // No shell commands should be needed for a text file with known MIME
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should read binary file with base64 encoding', async () => {
      const testPath = '/tmp/image.png';
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const binaryBuffer = binaryData.buffer as ArrayBuffer;

      mockBunFile({
        exists: true,
        size: 1024,
        type: 'image/png',
        arrayBuffer: binaryBuffer
      });

      const result = await fileService.read(testPath, {}, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        // Verify it's base64 encoded
        expect(result.metadata?.encoding).toBe('base64');
        expect(result.metadata?.isBinary).toBe(true);
        expect(result.metadata?.mimeType).toBe('image/png');
        expect(result.metadata?.size).toBe(1024);
        // Verify the content is valid base64
        expect(() => atob(result.data)).not.toThrow();
      }

      // No shell commands needed for a PNG file (known binary MIME from extension)
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should detect JSON files as text', async () => {
      const testPath = '/tmp/config.json';
      const testContent = '{"key": "value"}';

      mockBunFile({
        exists: true,
        size: 17,
        type: 'application/json',
        text: testContent
      });

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

      mockBunFile({
        exists: true,
        size: 20,
        type: 'text/javascript',
        text: testContent
      });

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
      mockBunFile({ exists: false });

      const result = await fileService.read('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should fall back to shell MIME detection for unknown extension files', async () => {
      // When Bun returns 'application/octet-stream' (unknown extension),
      // read() shells out to `file --mime-type` to get a better classification.
      const testContent = 'Some text content';
      mockBunFile({
        exists: true,
        size: 100,
        type: 'application/octet-stream', // triggers shell fallback
        text: testContent
      });

      // Shell fallback: `file --mime-type` returns text/plain
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'text/plain', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.metadata?.mimeType).toBe('text/plain');
        expect(result.metadata?.isBinary).toBe(false);
        expect(result.metadata?.encoding).toBe('utf-8');
      }

      // Verify the MIME fallback shell command was called
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'default',
        "file --mime-type -b '/tmp/test.txt'"
      );
    });

    it('should handle MIME type detection errors gracefully', async () => {
      mockBunFile({
        exists: true,
        size: 100,
        type: 'application/octet-stream'
      });

      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: 'Cannot detect MIME type' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.metadata?.mimeType).toBe('application/octet-stream');
        expect(result.metadata?.isBinary).toBe(true);
        expect(result.metadata?.encoding).toBe('base64');
      }
    });

    it('should handle read errors from Bun.file().text()', async () => {
      bunFileSpy = spyOn(Bun, 'file').mockImplementation((_path) => {
        return {
          exists: async () => true,
          size: 100,
          type: 'text/plain',
          text: async () => {
            throw new Error('Permission denied');
          },
          arrayBuffer: async () => new ArrayBuffer(0),
          stream: () => new ReadableStream(),
          bytes: async () => new Uint8Array()
        } as any;
      });

      const result = await fileService.read('/tmp/test.txt');

      expect(result.success).toBe(false);
    });

    it('should force base64 encoding when explicitly requested', async () => {
      const testPath = '/tmp/text.txt';
      const testContent = 'Hello World';
      const binaryBuffer = Buffer.from(testContent, 'utf-8')
        .buffer as ArrayBuffer;

      mockBunFile({
        exists: true,
        size: 11,
        type: 'text/plain',
        arrayBuffer: binaryBuffer
      });

      const result = await fileService.read(
        testPath,
        { encoding: 'base64' },
        'session-123'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.metadata?.encoding).toBe('base64');
        expect(result.metadata?.isBinary).toBe(true);
        expect(result.metadata?.mimeType).toBe('text/plain');
        // Verify it's valid base64 of the original content
        expect(atob(result.data)).toBe(testContent);
      }

      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should force utf-8 encoding when explicitly requested', async () => {
      const testPath = '/tmp/data.bin';
      const testContent = 'Some text content';

      mockBunFile({
        exists: true,
        size: 17,
        type: 'application/octet-stream',
        text: testContent
      });

      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'application/octet-stream', stderr: '' }
      } as ServiceResult<RawExecResult>);

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

      // Also test 'utf8' alias works the same way
      vi.clearAllMocks();
      mocked(mockSecurityService.validatePath).mockReturnValue({
        isValid: true,
        errors: []
      });
      mocked(mockSessionManager.withSession).mockImplementation(
        async (_sessionId, callback) => {
          try {
            const mockExec = async (cmd: string) => {
              const result = await mockSessionManager.executeInSession(
                _sessionId,
                cmd
              );
              if (result.success) return result.data;
              throw new Error('Command execution failed');
            };
            const data = await callback(mockExec);
            return { success: true, data } as any;
          } catch (error: any) {
            if (error && typeof error === 'object' && 'code' in error) {
              return { success: false, error } as any;
            }
            return {
              success: false,
              error: {
                code: 'INTERNAL_ERROR',
                message:
                  error instanceof Error ? error.message : 'Unknown error',
                details: {}
              }
            } as any;
          }
        }
      );
      mockBunFile({
        exists: true,
        size: 17,
        type: 'application/octet-stream',
        text: testContent
      });
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'application/octet-stream', stderr: '' }
      } as ServiceResult<RawExecResult>);

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

      mockBunFile({
        exists: true,
        size: 16,
        type: 'application/json',
        text: testContent
      });

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
      // Total: 3 calls (exists, isdir, delete)

      // Mock exists check (test -e returns 0 = file exists)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock isdir check (test -d returns non-zero = not a directory)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock delete command
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.delete(testPath, 'session-123');

      expect(result.success).toBe(true);

      // Verify rm command was called
      expect(mockSessionManager.executeInSession).toHaveBeenNthCalledWith(
        3,
        'session-123',
        "rm '/tmp/test.txt'"
      );
    });

    it('should return error when file does not exist', async () => {
      // Mock exists check returning false (exitCode 1 = file doesn't exist)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
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
      // Mock exists check (file exists)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: '', stderr: '' }
      } as ServiceResult<RawExecResult>);

      // Mock isdir check (not a directory)
      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 1, stdout: '', stderr: '' }
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

  describe('getFileMetadata', () => {
    it('should return metadata without reading file content', async () => {
      const testPath = '/tmp/large-file.bin';
      const fileSize = 50_000_000; // 50MB file

      mockBunFile({
        exists: true,
        size: fileSize,
        type: 'application/octet-stream'
      });

      mocked(mockSessionManager.executeInSession).mockResolvedValueOnce({
        success: true,
        data: { exitCode: 0, stdout: 'application/octet-stream', stderr: '' }
      } as ServiceResult<RawExecResult>);

      const result = await fileService.getFileMetadata(testPath, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.size).toBe(fileSize);
        expect(result.data.mimeType).toBe('application/octet-stream');
        expect(result.data.isBinary).toBe(true);
        expect(result.data.encoding).toBe('base64');
      }

      expect(mockSessionManager.executeInSession).toHaveBeenCalledTimes(1);
      expect(mockSessionManager.executeInSession).toHaveBeenCalledWith(
        'session-123',
        "file --mime-type -b '/tmp/large-file.bin'"
      );
    });

    it('should detect text files correctly', async () => {
      const testPath = '/tmp/document.json';

      mockBunFile({
        exists: true,
        size: 1024,
        type: 'application/json'
      });

      const result = await fileService.getFileMetadata(testPath, 'session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.size).toBe(1024);
        expect(result.data.mimeType).toBe('application/json');
        expect(result.data.isBinary).toBe(false);
        expect(result.data.encoding).toBe('utf-8');
      }

      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should return error when file does not exist', async () => {
      mockBunFile({ exists: false });

      const result = await fileService.getFileMetadata('/tmp/nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should return error when security validation fails', async () => {
      mocked(mockSecurityService.validatePath).mockReturnValue({
        isValid: false,
        errors: ['Path outside sandbox']
      });

      const result = await fileService.getFileMetadata('/etc/passwd');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
      }

      // Should not attempt any file operations
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
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

  describe('readFileStreamOperation', () => {
    /**
     * Helper: builds a ReadableStream<Uint8Array> from a string, split into
     * chunks of at most `chunkSize` bytes.  Mirrors how Bun.file().stream()
     * delivers data to the TransformStream inside readFileStreamOperation().
     */
    function makeTextStream(
      content: string,
      chunkSize = 65535
    ): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      const fullBytes = encoder.encode(content);

      return new ReadableStream<Uint8Array>({
        start(controller) {
          let offset = 0;
          while (offset < fullBytes.length) {
            controller.enqueue(fullBytes.subarray(offset, offset + chunkSize));
            offset += chunkSize;
          }
          controller.close();
        }
      });
    }

    it('should stream file using getFileMetadata without reading entire content upfront', async () => {
      const testPath = '/tmp/large-file.txt';
      const fileSize = 100_000; // 100KB file
      const chunkSize = 65_535;

      const chunkContent = 'A'.repeat(chunkSize);
      const secondChunkContent = 'B'.repeat(fileSize - chunkSize);
      const fullContent = chunkContent + secondChunkContent;

      mockBunFile({
        exists: true,
        size: fileSize,
        type: 'text/plain',
        stream: makeTextStream(fullContent, chunkSize)
      });

      const stream = await fileService.readFileStreamOperation(
        testPath,
        'session-123'
      );

      // Read all stream data
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const events: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }

      // Parse SSE events
      const allData = events.join('');
      const sseEvents = allData
        .split('\n\n')
        .filter((e) => e.startsWith('data: '))
        .map((e) => JSON.parse(e.replace('data: ', '')));

      // Verify metadata event was sent first
      expect(sseEvents[0]).toEqual({
        type: 'metadata',
        mimeType: 'text/plain',
        size: fileSize,
        isBinary: false,
        encoding: 'utf-8'
      });

      // Verify chunk events (TransformStream splits at CHUNK_SIZE boundaries)
      expect(sseEvents[1]).toEqual({
        type: 'chunk',
        data: chunkContent
      });
      expect(sseEvents[2]).toEqual({
        type: 'chunk',
        data: secondChunkContent
      });

      // Verify complete event with correct byte count
      expect(sseEvents[sseEvents.length - 1]).toEqual({
        type: 'complete',
        bytesRead: fileSize
      });

      // No shell commands should have been called — Bun handles everything
      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should stream binary files with base64 chunk encoding', async () => {
      const testPath = '/tmp/image.png';
      const fileSize = 16;
      // 16 bytes of PNG-like binary data
      const rawBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52
      ]);

      // Build a stream that emits the raw bytes in one chunk
      const binaryStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        }
      });

      mockBunFile({
        exists: true,
        size: fileSize,
        type: 'image/png',
        stream: binaryStream
      });

      const stream = await fileService.readFileStreamOperation(
        testPath,
        'session-123'
      );

      // Read stream
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const events: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }

      const allData = events.join('');
      const sseEvents = allData
        .split('\n\n')
        .filter((e) => e.startsWith('data: '))
        .map((e) => JSON.parse(e.replace('data: ', '')));

      // Verify metadata indicates binary
      expect(sseEvents[0]).toEqual({
        type: 'metadata',
        mimeType: 'image/png',
        size: fileSize,
        isBinary: true,
        encoding: 'base64'
      });

      // Chunk should be base64 encoded
      const chunkEvent = sseEvents[1];
      expect(chunkEvent.type).toBe('chunk');
      // Verify the base64 decodes back to the original bytes
      const decoded = Uint8Array.from(atob(chunkEvent.data), (c) =>
        c.charCodeAt(0)
      );
      expect(decoded).toEqual(rawBytes);

      expect(mockSessionManager.executeInSession).not.toHaveBeenCalled();
    });

    it('should return error event when file does not exist', async () => {
      mockBunFile({ exists: false });

      const stream = await fileService.readFileStreamOperation(
        '/tmp/nonexistent.txt',
        'session-123'
      );

      // Read stream
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const events: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }

      const allData = events.join('');
      const sseEvents = allData
        .split('\n\n')
        .filter((e) => e.startsWith('data: '))
        .map((e) => JSON.parse(e.replace('data: ', '')));

      // Should have error event
      expect(sseEvents[0].type).toBe('error');
      expect(sseEvents[0].error).toContain('File not found');
    });
  });
});
