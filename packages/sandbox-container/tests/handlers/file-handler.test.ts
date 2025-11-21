import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  DeleteFileResult,
  FileExistsResult,
  Logger,
  MkdirResult,
  MoveFileResult,
  ReadFileResult,
  RenameFileResult,
  WriteFileResult
} from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import type { RequestContext } from '@sandbox-container/core/types';
import { FileHandler } from '@sandbox-container/handlers/file-handler';
import type { FileService } from '@sandbox-container/services/file-service';

// Mock the dependencies - use partial mock to avoid missing properties
const mockFileService = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  moveFile: vi.fn(),
  createDirectory: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  rename: vi.fn(),
  move: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn(),
  getFileStats: vi.fn()
  // Remove private properties to avoid type conflicts
} as unknown as FileService;

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

// Mock request context
const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  },
  sessionId: 'session-456'
};

describe('FileHandler', () => {
  let fileHandler: FileHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    fileHandler = new FileHandler(mockFileService, mockLogger);
  });

  describe('handleRead - POST /api/read', () => {
    it('should read file successfully', async () => {
      const readFileData = {
        path: '/tmp/test.txt',
        encoding: 'utf-8'
      };
      const fileContent = 'Hello, World!';

      (mockFileService.readFile as any).mockResolvedValue({
        success: true,
        data: fileContent
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ReadFileResult;
      expect(responseData.success).toBe(true);
      expect(responseData.content).toBe(fileContent);
      expect(responseData.path).toBe('/tmp/test.txt');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockFileService.readFile).toHaveBeenCalledWith('/tmp/test.txt', {
        encoding: 'utf-8'
      });
    });

    it('should pass undefined encoding when not specified', async () => {
      const readFileData = {
        path: '/tmp/test.txt'
        // encoding not specified
      };

      (mockFileService.readFile as any).mockResolvedValue({
        success: true,
        data: 'file content'
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ReadFileResult;
      expect(responseData.success).toBe(true);
      expect(responseData.content).toBeDefined();
      expect(responseData.path).toBe('/tmp/test.txt');
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.readFile).toHaveBeenCalledWith('/tmp/test.txt', {
        encoding: undefined
      });
    });

    it('should handle file read errors', async () => {
      const readFileData = { path: '/tmp/nonexistent.txt' };

      (mockFileService.readFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'File not found',
          code: 'FILE_NOT_FOUND',
          details: { path: '/tmp/nonexistent.txt' }
        }
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('FILE_NOT_FOUND');
      expect(responseData.message).toBe('File not found');
      expect(responseData.httpStatus).toBe(404);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleWrite - POST /api/write', () => {
    it('should write file successfully', async () => {
      const writeFileData = {
        path: '/tmp/output.txt',
        content: 'Hello, File!',
        encoding: 'utf-8'
      };

      (mockFileService.writeFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as WriteFileResult;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/output.txt'); // ✅ Check path field
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockFileService.writeFile).toHaveBeenCalledWith(
        '/tmp/output.txt',
        'Hello, File!',
        {
          encoding: 'utf-8'
        }
      );
    });

    it('should handle file write errors', async () => {
      const writeFileData = {
        path: '/readonly/file.txt',
        content: 'content'
      };

      (mockFileService.writeFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Permission denied',
          code: 'PERMISSION_DENIED',
          details: { path: '/readonly/file.txt' }
        }
      });

      const request = new Request('http://localhost:3000/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(403);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('PERMISSION_DENIED');
      expect(responseData.message).toBe('Permission denied');
      expect(responseData.httpStatus).toBe(403);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleDelete - POST /api/delete', () => {
    it('should delete file successfully', async () => {
      const deleteFileData = {
        path: '/tmp/delete-me.txt'
      };

      (mockFileService.deleteFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as DeleteFileResult;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/delete-me.txt'); // ✅ Check path field
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.deleteFile).toHaveBeenCalledWith(
        '/tmp/delete-me.txt'
      );
    });

    it('should handle file delete errors', async () => {
      const deleteFileData = { path: '/tmp/nonexistent.txt' };

      (mockFileService.deleteFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'File not found',
          code: 'FILE_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('FILE_NOT_FOUND');
      expect(responseData.message).toBe('File not found');
      expect(responseData.httpStatus).toBe(404);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleRename - POST /api/rename', () => {
    it('should rename file successfully', async () => {
      const renameFileData = {
        oldPath: '/tmp/old-name.txt',
        newPath: '/tmp/new-name.txt'
      };

      (mockFileService.renameFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renameFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as RenameFileResult;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/old-name.txt');
      expect(responseData.newPath).toBe('/tmp/new-name.txt');
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.renameFile).toHaveBeenCalledWith(
        '/tmp/old-name.txt',
        '/tmp/new-name.txt'
      );
    });

    it('should handle file rename errors', async () => {
      const renameFileData = {
        oldPath: '/tmp/nonexistent.txt',
        newPath: '/tmp/renamed.txt'
      };

      (mockFileService.renameFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Source file not found',
          code: 'FILE_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renameFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('FILE_NOT_FOUND');
      expect(responseData.message).toBe('Source file not found');
      expect(responseData.httpStatus).toBe(404);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleMove - POST /api/move', () => {
    it('should move file successfully', async () => {
      const moveFileData = {
        sourcePath: '/tmp/source.txt',
        destinationPath: '/tmp/destination.txt'
      };

      (mockFileService.moveFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moveFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as MoveFileResult;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/source.txt');
      expect(responseData.newPath).toBe('/tmp/destination.txt');
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.moveFile).toHaveBeenCalledWith(
        '/tmp/source.txt',
        '/tmp/destination.txt'
      );
    });

    it('should handle file move errors', async () => {
      const moveFileData = {
        sourcePath: '/tmp/source.txt',
        destinationPath: '/readonly/destination.txt'
      };

      (mockFileService.moveFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Permission denied on destination',
          code: 'PERMISSION_DENIED'
        }
      });

      const request = new Request('http://localhost:3000/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moveFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(403);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('PERMISSION_DENIED');
      expect(responseData.message).toBe('Permission denied on destination');
      expect(responseData.httpStatus).toBe(403);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleMkdir - POST /api/mkdir', () => {
    it('should create directory successfully', async () => {
      const mkdirData = {
        path: '/tmp/new-directory',
        recursive: true
      };

      (mockFileService.createDirectory as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mkdirData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as MkdirResult;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/new-directory');
      expect(responseData.recursive).toBe(true);
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.createDirectory).toHaveBeenCalledWith(
        '/tmp/new-directory',
        {
          recursive: true
        }
      );
    });

    it('should create directory without recursive option', async () => {
      const mkdirData = {
        path: '/tmp/simple-dir'
        // recursive not specified
      };

      (mockFileService.createDirectory as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mkdirData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as MkdirResult;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/simple-dir');
      expect(responseData.recursive).toBe(false);
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.createDirectory).toHaveBeenCalledWith(
        '/tmp/simple-dir',
        {
          recursive: undefined
        }
      );
    });

    it('should handle directory creation errors', async () => {
      const mkdirData = {
        path: '/readonly/new-dir',
        recursive: false
      };

      (mockFileService.createDirectory as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Permission denied',
          code: 'PERMISSION_DENIED'
        }
      });

      const request = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mkdirData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(403);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('PERMISSION_DENIED');
      expect(responseData.message).toBe('Permission denied');
      expect(responseData.httpStatus).toBe(403);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleExists - POST /api/exists', () => {
    it('should return true when file exists', async () => {
      const existsData = {
        path: '/tmp/test.txt',
        sessionId: 'session-123'
      };

      (mockFileService.exists as any).mockResolvedValue({
        success: true,
        data: true
      });

      const request = new Request('http://localhost:3000/api/exists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existsData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as FileExistsResult;
      expect(responseData.success).toBe(true);
      expect(responseData.exists).toBe(true);
      expect(responseData.path).toBe('/tmp/test.txt');
      expect(responseData.timestamp).toBeDefined();

      expect(mockFileService.exists).toHaveBeenCalledWith(
        '/tmp/test.txt',
        'session-123'
      );
    });

    it('should return false when file does not exist', async () => {
      const existsData = {
        path: '/tmp/nonexistent.txt',
        sessionId: 'session-123'
      };

      (mockFileService.exists as any).mockResolvedValue({
        success: true,
        data: false
      });

      const request = new Request('http://localhost:3000/api/exists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existsData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as FileExistsResult;
      expect(responseData.success).toBe(true);
      expect(responseData.exists).toBe(false);
    });

    it('should handle errors when checking file existence', async () => {
      const existsData = {
        path: '/invalid/path',
        sessionId: 'session-123'
      };

      (mockFileService.exists as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Invalid path',
          code: 'VALIDATION_FAILED',
          httpStatus: 400
        }
      });

      const request = new Request('http://localhost:3000/api/exists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existsData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('route handling', () => {
    it('should return 500 for invalid endpoints', async () => {
      const request = new Request(
        'http://localhost:3000/api/invalid-operation',
        {
          method: 'POST'
        }
      );

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toContain('Invalid file endpoint');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle root path correctly', async () => {
      const request = new Request('http://localhost:3000/', {
        method: 'GET'
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toContain('Invalid file endpoint');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in all successful responses', async () => {
      const readFileData = { path: '/tmp/test.txt' };

      (mockFileService.readFile as any).mockResolvedValue({
        success: true,
        data: 'file content'
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/invalid', {
        method: 'POST'
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should have domain-specific response formats for each operation', async () => {
      // Test all operations return correct domain-specific fields
      const operations = [
        {
          endpoint: '/api/read',
          data: { path: '/tmp/test.txt' },
          mockResponse: { success: true, data: 'content' },
          expectedFields: ['success', 'path', 'content', 'timestamp']
        },
        {
          endpoint: '/api/write',
          data: { path: '/tmp/test.txt', content: 'data' },
          mockResponse: { success: true },
          expectedFields: ['success', 'path', 'timestamp']
        },
        {
          endpoint: '/api/delete',
          data: { path: '/tmp/test.txt' },
          mockResponse: { success: true },
          expectedFields: ['success', 'path', 'timestamp']
        }
      ];

      for (const operation of operations) {
        // Reset mocks
        vi.clearAllMocks();

        // Mock appropriate service method
        if (operation.endpoint === '/api/read') {
          (mockFileService.readFile as any).mockResolvedValue(
            operation.mockResponse
          );
        } else if (operation.endpoint === '/api/write') {
          (mockFileService.writeFile as any).mockResolvedValue(
            operation.mockResponse
          );
        } else if (operation.endpoint === '/api/delete') {
          (mockFileService.deleteFile as any).mockResolvedValue(
            operation.mockResponse
          );
        }

        const request = new Request(
          `http://localhost:3000${operation.endpoint}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(operation.data)
          }
        );

        const response = await fileHandler.handle(request, mockContext);
        const responseData = (await response.json()) as
          | ReadFileResult
          | WriteFileResult
          | DeleteFileResult;

        // Check that all expected fields are present
        for (const field of operation.expectedFields) {
          expect(responseData).toHaveProperty(field);
        }

        // Ensure no generic 'data' wrapper exists (except for read which has 'content')
        if (operation.endpoint !== '/api/read') {
          expect(responseData).not.toHaveProperty('data');
        }

        // Check common fields
        expect(responseData.success).toBe(true);
        expect(responseData.timestamp).toBeDefined();
      }
    });
  });
});
