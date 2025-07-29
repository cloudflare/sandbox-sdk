import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileClient } from '../../clients/file-client';
import type { 
  MkdirResponse, 
  WriteFileResponse, 
  ReadFileResponse, 
  FileOperationResponse,
  HttpClientOptions 
} from '../../clients/types';

describe('FileClient', () => {
  let client: FileClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new FileClient({
      baseUrl: 'http://test.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultClient = new FileClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const customClient = new FileClient({
        baseUrl: 'http://custom.com',
        port: 8080,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });
  });

  describe('mkdir', () => {
    const mockResponse: MkdirResponse = {
      success: true,
      stdout: 'Directory created successfully',
      stderr: '',
      exitCode: 0,
      path: '/test/directory',
      recursive: false,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should create directory successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.mkdir('/test/directory');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/mkdir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/directory',
          recursive: false,
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should create directory recursively', async () => {
      const recursiveResponse = { ...mockResponse, recursive: true };
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(recursiveResponse), { status: 200 })
      );

      await client.mkdir('/test/nested/directory', { recursive: true });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/mkdir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/nested/directory',
          recursive: true,
        }),
      });
    });

    it('should create directory with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.mkdir('/test/directory', { sessionId: 'session-123' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/mkdir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/directory',
          recursive: false,
          sessionId: 'session-123',
        }),
      });
    });

    it('should handle mkdir errors', async () => {
      const errorResponse = {
        error: 'Permission denied',
        code: 'PERMISSION_DENIED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 403 })
      );

      await expect(client.mkdir('/root/directory')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('writeFile', () => {
    const mockResponse: WriteFileResponse = {
      success: true,
      exitCode: 0,
      path: '/test/file.txt',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should write file successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const content = 'Hello, World!';
      const result = await client.writeFile('/test/file.txt', content);

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/file.txt',
          content: 'Hello, World!',
          encoding: 'utf8',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should write file with custom encoding', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.writeFile('/test/binary.dat', 'binary data', { encoding: 'base64' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/binary.dat',
          content: 'binary data',
          encoding: 'base64',
        }),
      });
    });

    it('should write file with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.writeFile('/test/file.txt', 'content', { sessionId: 'session-456' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/file.txt',
          content: 'content',
          encoding: 'utf8',
          sessionId: 'session-456',
        }),
      });
    });

    it('should handle write errors', async () => {
      const errorResponse = {
        error: 'Disk full',
        code: 'DISK_FULL',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.writeFile('/test/file.txt', 'content')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('readFile', () => {
    const mockResponse: ReadFileResponse = {
      success: true,
      exitCode: 0,
      path: '/test/file.txt',
      content: 'File contents here',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should read file successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.readFile('/test/file.txt');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/file.txt',
          encoding: 'utf8',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should read file with custom encoding', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.readFile('/test/binary.dat', { encoding: 'base64' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/binary.dat',
          encoding: 'base64',
        }),
      });
    });

    it('should read file with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.readFile('/test/file.txt', { sessionId: 'session-789' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/file.txt',
          encoding: 'utf8',
          sessionId: 'session-789',
        }),
      });
    });

    it('should handle read errors', async () => {
      const errorResponse = {
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.readFile('/nonexistent/file.txt')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('deleteFile', () => {
    const mockResponse: FileOperationResponse = {
      success: true,
      exitCode: 0,
      path: '/test/file.txt',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should delete file successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.deleteFile('/test/file.txt');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/file.txt',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should delete file with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.deleteFile('/test/file.txt', 'session-delete');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: '/test/file.txt',
          sessionId: 'session-delete',
        }),
      });
    });

    it('should handle delete errors', async () => {
      const errorResponse = {
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.deleteFile('/nonexistent/file.txt')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('renameFile', () => {
    const mockResponse: FileOperationResponse = {
      success: true,
      exitCode: 0,
      path: '/test/old.txt',
      newPath: '/test/new.txt',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should rename file successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.renameFile('/test/old.txt', '/test/new.txt');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          oldPath: '/test/old.txt',
          newPath: '/test/new.txt',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should rename file with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.renameFile('/test/old.txt', '/test/new.txt', 'session-rename');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          oldPath: '/test/old.txt',
          newPath: '/test/new.txt',
          sessionId: 'session-rename',
        }),
      });
    });

    it('should handle rename errors', async () => {
      const errorResponse = {
        error: 'Target file already exists',
        code: 'FILE_EXISTS',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(client.renameFile('/test/old.txt', '/test/existing.txt')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('moveFile', () => {
    const mockResponse: FileOperationResponse = {
      success: true,
      exitCode: 0,
      path: '/src/file.txt',
      newPath: '/dest/file.txt',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should move file successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.moveFile('/src/file.txt', '/dest/file.txt');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sourcePath: '/src/file.txt',
          destinationPath: '/dest/file.txt',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should move file with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.moveFile('/src/file.txt', '/dest/file.txt', 'session-move');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sourcePath: '/src/file.txt',
          destinationPath: '/dest/file.txt',
          sessionId: 'session-move',
        }),
      });
    });

    it('should handle move errors', async () => {
      const errorResponse = {
        error: 'Destination directory does not exist',
        code: 'DIRECTORY_NOT_FOUND',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.moveFile('/src/file.txt', '/nonexistent/file.txt')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });
});