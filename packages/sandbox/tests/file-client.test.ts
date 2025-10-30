import type {
  DeleteFileResult,
  FileExistsResult,
  ListFilesResult,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  RenameFileResult,
  WriteFileResult
} from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileClient } from '../src/clients/file-client';
import {
  FileExistsError,
  FileNotFoundError,
  FileSystemError,
  PermissionDeniedError,
  SandboxError
} from '../src/errors';

describe('FileClient', () => {
  let client: FileClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new FileClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('mkdir', () => {
    it('should create directories successfully', async () => {
      const mockResponse: MkdirResult = {
        success: true,
        exitCode: 0,
        path: '/app/new-directory',
        recursive: false,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.mkdir('/app/new-directory', 'session-mkdir');

      expect(result.success).toBe(true);
      expect(result.path).toBe('/app/new-directory');
      expect(result.recursive).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it('should create directories recursively', async () => {
      const mockResponse: MkdirResult = {
        success: true,
        exitCode: 0,
        path: '/app/deep/nested/directory',
        recursive: true,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.mkdir(
        '/app/deep/nested/directory',
        'session-mkdir',
        { recursive: true }
      );

      expect(result.success).toBe(true);
      expect(result.recursive).toBe(true);
      expect(result.path).toBe('/app/deep/nested/directory');
    });

    it('should handle permission denied errors', async () => {
      const errorResponse = {
        error: 'Permission denied: cannot create directory /root/secure',
        code: 'PERMISSION_DENIED',
        path: '/root/secure'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 403 })
      );

      await expect(
        client.mkdir('/root/secure', 'session-mkdir')
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('should handle directory already exists errors', async () => {
      const errorResponse = {
        error: 'Directory already exists: /app/existing',
        code: 'FILE_EXISTS',
        path: '/app/existing'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(
        client.mkdir('/app/existing', 'session-mkdir')
      ).rejects.toThrow(FileExistsError);
    });
  });

  describe('writeFile', () => {
    it('should write files successfully', async () => {
      const mockResponse: WriteFileResult = {
        success: true,
        exitCode: 0,
        path: '/app/config.json',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const content = '{"setting": "value", "enabled": true}';
      const result = await client.writeFile(
        '/app/config.json',
        content,
        'session-write'
      );

      expect(result.success).toBe(true);
      expect(result.path).toBe('/app/config.json');
      expect(result.exitCode).toBe(0);
    });

    it('should write files with different encodings', async () => {
      const mockResponse: WriteFileResult = {
        success: true,
        exitCode: 0,
        path: '/app/image.png',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const binaryData =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jYlkKQAAAABJRU5ErkJggg==';
      const result = await client.writeFile(
        '/app/image.png',
        binaryData,
        'session-write',
        { encoding: 'base64' }
      );

      expect(result.success).toBe(true);
      expect(result.path).toBe('/app/image.png');
    });

    it('should handle write permission errors', async () => {
      const errorResponse = {
        error: 'Permission denied: cannot write to /system/readonly.txt',
        code: 'PERMISSION_DENIED',
        path: '/system/readonly.txt'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 403 })
      );

      await expect(
        client.writeFile('/system/readonly.txt', 'content', 'session-err')
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('should handle disk space errors', async () => {
      const errorResponse = {
        error: 'No space left on device',
        code: 'NO_SPACE',
        path: '/app/largefile.dat'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 507 })
      );

      await expect(
        client.writeFile(
          '/app/largefile.dat',
          'x'.repeat(1000000),
          'session-err'
        )
      ).rejects.toThrow(FileSystemError);
    });
  });

  describe('readFile', () => {
    it('should read text files successfully with metadata', async () => {
      const fileContent = `# Configuration File
server:
  port: 3000
  host: localhost
database:
  url: postgresql://localhost/app`;

      const mockResponse: ReadFileResult = {
        success: true,
        exitCode: 0,
        path: '/app/config.yaml',
        content: fileContent,
        timestamp: '2023-01-01T00:00:00Z',
        encoding: 'utf-8',
        isBinary: false,
        mimeType: 'text/yaml',
        size: 100
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.readFile('/app/config.yaml', 'session-read');

      expect(result.success).toBe(true);
      expect(result.path).toBe('/app/config.yaml');
      expect(result.content).toContain('port: 3000');
      expect(result.content).toContain('postgresql://localhost/app');
      expect(result.exitCode).toBe(0);
      expect(result.encoding).toBe('utf-8');
      expect(result.isBinary).toBe(false);
      expect(result.mimeType).toBe('text/yaml');
      expect(result.size).toBe(100);
    });

    it('should read binary files with base64 encoding and metadata', async () => {
      const binaryContent =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jYlkKQAAAABJRU5ErkJggg==';
      const mockResponse: ReadFileResult = {
        success: true,
        exitCode: 0,
        path: '/app/logo.png',
        content: binaryContent,
        timestamp: '2023-01-01T00:00:00Z',
        encoding: 'base64',
        isBinary: true,
        mimeType: 'image/png',
        size: 95
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.readFile('/app/logo.png', 'session-read', {
        encoding: 'base64'
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe(binaryContent);
      expect(result.content.startsWith('iVBORw0K')).toBe(true);
      expect(result.encoding).toBe('base64');
      expect(result.isBinary).toBe(true);
      expect(result.mimeType).toBe('image/png');
      expect(result.size).toBe(95);
    });

    it('should handle file not found errors', async () => {
      const errorResponse = {
        error: 'File not found: /app/missing.txt',
        code: 'FILE_NOT_FOUND',
        path: '/app/missing.txt'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(
        client.readFile('/app/missing.txt', 'session-read')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should handle directory read attempts', async () => {
      const errorResponse = {
        error: 'Is a directory: /app/logs',
        code: 'IS_DIRECTORY',
        path: '/app/logs'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(
        client.readFile('/app/logs', 'session-read')
      ).rejects.toThrow(FileSystemError);
    });
  });

  describe('readFileStream', () => {
    it('should stream file successfully', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"metadata","mimeType":"text/plain","size":100,"isBinary":false,"encoding":"utf-8"}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"chunk","data":"Hello"}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"complete","bytesRead":5}\n\n'
            )
          );
          controller.close();
        }
      });

      mockFetch.mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const result = await client.readFileStream(
        '/app/test.txt',
        'session-stream'
      );

      expect(result).toBeInstanceOf(ReadableStream);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/read/stream'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            path: '/app/test.txt',
            sessionId: 'session-stream'
          })
        })
      );
    });

    it('should handle binary file streams', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"metadata","mimeType":"image/png","size":1024,"isBinary":true,"encoding":"base64"}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"chunk","data":"iVBORw0K"}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"complete","bytesRead":1024}\n\n'
            )
          );
          controller.close();
        }
      });

      mockFetch.mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const result = await client.readFileStream(
        '/app/image.png',
        'session-stream'
      );

      expect(result).toBeInstanceOf(ReadableStream);
    });

    it('should handle stream errors', async () => {
      const errorResponse = {
        error: 'File not found: /app/missing.txt',
        code: 'FILE_NOT_FOUND',
        path: '/app/missing.txt'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(
        client.readFileStream('/app/missing.txt', 'session-stream')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should handle network errors during streaming', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      await expect(
        client.readFileStream('/app/file.txt', 'session-stream')
      ).rejects.toThrow('Network timeout');
    });
  });

  describe('deleteFile', () => {
    it('should delete files successfully', async () => {
      const mockResponse: DeleteFileResult = {
        success: true,
        exitCode: 0,
        path: '/app/temp.txt',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.deleteFile('/app/temp.txt', 'session-delete');

      expect(result.success).toBe(true);
      expect(result.path).toBe('/app/temp.txt');
      expect(result.exitCode).toBe(0);
    });

    it('should handle delete non-existent file', async () => {
      const errorResponse = {
        error: 'File not found: /app/nonexistent.txt',
        code: 'FILE_NOT_FOUND',
        path: '/app/nonexistent.txt'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(
        client.deleteFile('/app/nonexistent.txt', 'session-delete')
      ).rejects.toThrow(FileNotFoundError);
    });

    it('should handle delete permission errors', async () => {
      const errorResponse = {
        error: 'Permission denied: cannot delete /system/important.conf',
        code: 'PERMISSION_DENIED',
        path: '/system/important.conf'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 403 })
      );

      await expect(
        client.deleteFile('/system/important.conf', 'session-delete')
      ).rejects.toThrow(PermissionDeniedError);
    });
  });

  describe('renameFile', () => {
    it('should rename files successfully', async () => {
      const mockResponse: RenameFileResult = {
        success: true,
        exitCode: 0,
        path: '/app/old-name.txt',
        newPath: '/app/new-name.txt',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.renameFile(
        '/app/old-name.txt',
        '/app/new-name.txt',
        'session-rename'
      );

      expect(result.success).toBe(true);
      expect(result.path).toBe('/app/old-name.txt');
      expect(result.newPath).toBe('/app/new-name.txt');
      expect(result.exitCode).toBe(0);
    });

    it('should handle rename to existing file', async () => {
      const errorResponse = {
        error: 'Target file already exists: /app/existing.txt',
        code: 'FILE_EXISTS',
        path: '/app/existing.txt'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(
        client.renameFile(
          '/app/source.txt',
          '/app/existing.txt',
          'session-rename'
        )
      ).rejects.toThrow(FileExistsError);
    });
  });

  describe('moveFile', () => {
    it('should move files successfully', async () => {
      const mockResponse: MoveFileResult = {
        success: true,
        exitCode: 0,
        path: '/src/document.pdf',
        newPath: '/dest/document.pdf',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.moveFile(
        '/src/document.pdf',
        '/dest/document.pdf',
        'session-move'
      );

      expect(result.success).toBe(true);
      expect(result.path).toBe('/src/document.pdf');
      expect(result.newPath).toBe('/dest/document.pdf');
      expect(result.exitCode).toBe(0);
    });

    it('should handle move to non-existent directory', async () => {
      const errorResponse = {
        error: 'Destination directory does not exist: /nonexistent/',
        code: 'NOT_DIRECTORY',
        path: '/nonexistent/'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(
        client.moveFile(
          '/app/file.txt',
          '/nonexistent/file.txt',
          'session-move'
        )
      ).rejects.toThrow(FileSystemError);
    });
  });

  describe('listFiles', () => {
    const createMockFile = (overrides: Partial<any> = {}) => ({
      name: 'test.txt',
      absolutePath: '/workspace/test.txt',
      relativePath: 'test.txt',
      type: 'file' as const,
      size: 1024,
      modifiedAt: '2023-01-01T00:00:00Z',
      mode: 'rw-r--r--',
      permissions: { readable: true, writable: true, executable: false },
      ...overrides
    });

    it('should list files with correct structure', async () => {
      const mockResponse: ListFilesResult = {
        success: true,
        path: '/workspace',
        files: [
          createMockFile({ name: 'file.txt' }),
          createMockFile({ name: 'dir', type: 'directory', mode: 'rwxr-xr-x' })
        ],
        count: 2,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.listFiles('/workspace', 'session-list');

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.files[0].name).toBe('file.txt');
      expect(result.files[1].name).toBe('dir');
      expect(result.files[1].type).toBe('directory');
    });

    it('should pass options correctly', async () => {
      const mockResponse: ListFilesResult = {
        success: true,
        path: '/workspace',
        files: [createMockFile({ name: '.hidden', relativePath: '.hidden' })],
        count: 1,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.listFiles('/workspace', 'session-list', {
        recursive: true,
        includeHidden: true
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/list-files'),
        expect.objectContaining({
          body: JSON.stringify({
            path: '/workspace',
            sessionId: 'session-list',
            options: { recursive: true, includeHidden: true }
          })
        })
      );
    });

    it('should handle empty directories', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            path: '/empty',
            files: [],
            count: 0,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      const result = await client.listFiles('/empty', 'session-list');

      expect(result.count).toBe(0);
      expect(result.files).toHaveLength(0);
    });

    it('should handle error responses', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Directory not found',
            code: 'FILE_NOT_FOUND'
          }),
          { status: 404 }
        )
      );

      await expect(
        client.listFiles('/nonexistent', 'session-list')
      ).rejects.toThrow(FileNotFoundError);
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      const mockResponse: FileExistsResult = {
        success: true,
        path: '/workspace/test.txt',
        exists: true,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exists(
        '/workspace/test.txt',
        'session-exists'
      );

      expect(result.success).toBe(true);
      expect(result.exists).toBe(true);
      expect(result.path).toBe('/workspace/test.txt');
    });

    it('should return false when file does not exist', async () => {
      const mockResponse: FileExistsResult = {
        success: true,
        path: '/workspace/nonexistent.txt',
        exists: false,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exists(
        '/workspace/nonexistent.txt',
        'session-exists'
      );

      expect(result.success).toBe(true);
      expect(result.exists).toBe(false);
    });

    it('should return true when directory exists', async () => {
      const mockResponse: FileExistsResult = {
        success: true,
        path: '/workspace/some-dir',
        exists: true,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exists(
        '/workspace/some-dir',
        'session-exists'
      );

      expect(result.success).toBe(true);
      expect(result.exists).toBe(true);
    });

    it('should send correct request payload', async () => {
      const mockResponse: FileExistsResult = {
        success: true,
        path: '/test/path',
        exists: true,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.exists('/test/path', 'session-test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/exists'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            path: '/test/path',
            sessionId: 'session-test'
          })
        })
      );
    });
  });

  describe('error handling', () => {
    it('should handle network failures gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(
        client.readFile('/app/file.txt', 'session-read')
      ).rejects.toThrow('Network connection failed');
    });

    it('should handle malformed server responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(
        client.writeFile('/app/file.txt', 'content', 'session-err')
      ).rejects.toThrow(SandboxError);
    });

    it('should handle server errors with proper mapping', async () => {
      const serverErrorScenarios = [
        { status: 400, code: 'FILESYSTEM_ERROR', error: FileSystemError },
        {
          status: 403,
          code: 'PERMISSION_DENIED',
          error: PermissionDeniedError
        },
        { status: 404, code: 'FILE_NOT_FOUND', error: FileNotFoundError },
        { status: 409, code: 'FILE_EXISTS', error: FileExistsError },
        { status: 500, code: 'INTERNAL_ERROR', error: SandboxError }
      ];

      for (const scenario of serverErrorScenarios) {
        mockFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: 'Test error',
              code: scenario.code
            }),
            { status: scenario.status }
          )
        );

        await expect(
          client.readFile('/app/test.txt', 'session-read')
        ).rejects.toThrow(scenario.error);
      }
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new FileClient();
      expect(minimalClient).toBeDefined();
    });

    it('should initialize with full options', () => {
      const fullOptionsClient = new FileClient({
        baseUrl: 'http://custom.com',
        port: 8080
      });
      expect(fullOptionsClient).toBeDefined();
    });
  });
});
