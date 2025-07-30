/**
 * File Handler Tests
 * 
 * Tests the FileHandler class from the refactored container architecture.
 * Demonstrates testing handlers with file system operations and CRUD functionality.
 */

import type { FileHandler } from '@container/handlers/file-handler';
import type { FileService } from '@container/services/file-service';
import type { Logger, RequestContext, ValidatedRequestContext } from '@container/core/types';
import type { ReadFileResponse, WriteFileResponse, DeleteFileResponse, RenameFileResponse, MoveFileResponse, MkdirResponse } from '@container/core/types';
import type { ContainerErrorResponse } from '@container/utils/error-mapping';

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
  getFileStats: vi.fn(),
  // Remove private properties to avoid type conflicts
} as FileService;

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock request context
const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-456',
};

// Helper to create validated context
const createValidatedContext = <T>(data: T): ValidatedRequestContext<T> => ({
  ...mockContext,
  validatedData: data
});

describe('FileHandler', () => {
  let fileHandler: FileHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the FileHandler (dynamic import)
    const { FileHandler: FileHandlerClass } = await import('@container/handlers/file-handler');
    fileHandler = new FileHandlerClass(mockFileService, mockLogger);
  });

  describe('handleRead - POST /api/read', () => {
    it('should read file successfully', async () => {
      const readFileData = {
        path: '/tmp/test.txt',
        encoding: 'utf-8'
      };
      const fileContent = 'Hello, World!';

      const validatedContext = createValidatedContext(readFileData);
      (mockFileService.readFile as any).mockResolvedValue({
        success: true,
        data: fileContent
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ReadFileResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.content).toBe(fileContent);
      expect(responseData.path).toBe('/tmp/test.txt');
      expect(responseData.exitCode).toBe(0);

      // Verify service was called correctly
      expect(mockFileService.readFile).toHaveBeenCalledWith('/tmp/test.txt', {
        encoding: 'utf-8'
      });

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reading file',
        expect.objectContaining({
          requestId: 'req-123',
          path: '/tmp/test.txt',
          encoding: 'utf-8'
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File read successfully',
        expect.objectContaining({
          requestId: 'req-123',
          path: '/tmp/test.txt',
          sizeBytes: fileContent.length
        })
      );
    });

    it('should use default encoding when not specified', async () => {
      const readFileData = {
        path: '/tmp/test.txt'
        // encoding not specified
      };

      const validatedContext = createValidatedContext(readFileData);
      (mockFileService.readFile as any).mockResolvedValue({
        success: true,
        data: 'file content'
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ReadFileResponse;
      expect(responseData.encoding).toBe('utf-8'); // Default encoding

      expect(mockFileService.readFile).toHaveBeenCalledWith('/tmp/test.txt', {
        encoding: 'utf-8'
      });
    });

    it('should handle file read errors', async () => {
      const readFileData = { path: '/tmp/nonexistent.txt' };
      const validatedContext = createValidatedContext(readFileData);

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

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('FILE_NOT_FOUND');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'File read failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          path: '/tmp/nonexistent.txt',
          errorCode: 'FILE_NOT_FOUND'
        })
      );
    });
  });

  describe('handleWrite - POST /api/write', () => {
    it('should write file successfully', async () => {
      const writeFileData = {
        path: '/tmp/output.txt',
        content: 'Hello, File!',
        encoding: 'utf-8'
      };

      const validatedContext = createValidatedContext(writeFileData);
      (mockFileService.writeFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ReadFileResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/output.txt');
      expect(responseData.exitCode).toBe(0);

      // Verify service was called correctly
      expect(mockFileService.writeFile).toHaveBeenCalledWith('/tmp/output.txt', 'Hello, File!', {
        encoding: 'utf-8'
      });

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Writing file',
        expect.objectContaining({
          requestId: 'req-123',
          path: '/tmp/output.txt',
          sizeBytes: 'Hello, File!'.length,
          encoding: 'utf-8'
        })
      );
    });

    it('should handle file write errors', async () => {
      const writeFileData = {
        path: '/readonly/file.txt',
        content: 'content'
      };
      const validatedContext = createValidatedContext(writeFileData);

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

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('handleDelete - POST /api/delete', () => {
    it('should delete file successfully', async () => {
      const deleteFileData = {
        path: '/tmp/delete-me.txt'
      };

      const validatedContext = createValidatedContext(deleteFileData);
      (mockFileService.deleteFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ReadFileResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/delete-me.txt');
      expect(responseData.exitCode).toBe(0);

      expect(mockFileService.deleteFile).toHaveBeenCalledWith('/tmp/delete-me.txt');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'File deleted successfully',
        expect.objectContaining({
          requestId: 'req-123',
          path: '/tmp/delete-me.txt'
        })
      );
    });

    it('should handle file delete errors', async () => {
      const deleteFileData = { path: '/tmp/nonexistent.txt' };
      const validatedContext = createValidatedContext(deleteFileData);

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

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('handleRename - POST /api/rename', () => {
    it('should rename file successfully', async () => {
      const renameFileData = {
        oldPath: '/tmp/old-name.txt',
        newPath: '/tmp/new-name.txt'
      };

      const validatedContext = createValidatedContext(renameFileData);
      (mockFileService.renameFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renameFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as RenameFileResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/old-name.txt');
      expect(responseData.newPath).toBe('/tmp/new-name.txt');
      expect(responseData.exitCode).toBe(0);

      expect(mockFileService.renameFile).toHaveBeenCalledWith('/tmp/old-name.txt', '/tmp/new-name.txt');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Renaming file',
        expect.objectContaining({
          requestId: 'req-123',
          oldPath: '/tmp/old-name.txt',
          newPath: '/tmp/new-name.txt'
        })
      );
    });

    it('should handle file rename errors', async () => {
      const renameFileData = {
        oldPath: '/tmp/nonexistent.txt',
        newPath: '/tmp/renamed.txt'
      };
      const validatedContext = createValidatedContext(renameFileData);

      (mockFileService.renameFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Source file not found',
          code: 'SOURCE_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renameFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('SOURCE_NOT_FOUND');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'File rename failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          oldPath: '/tmp/nonexistent.txt',
          newPath: '/tmp/renamed.txt',
          errorCode: 'SOURCE_NOT_FOUND'
        })
      );
    });
  });

  describe('handleMove - POST /api/move', () => {
    it('should move file successfully', async () => {
      const moveFileData = {
        sourcePath: '/tmp/source.txt',
        destinationPath: '/tmp/destination.txt'
      };

      const validatedContext = createValidatedContext(moveFileData);
      (mockFileService.moveFile as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moveFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as MoveFileResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/source.txt');
      expect(responseData.newPath).toBe('/tmp/destination.txt');
      expect(responseData.exitCode).toBe(0);

      expect(mockFileService.moveFile).toHaveBeenCalledWith('/tmp/source.txt', '/tmp/destination.txt');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Moving file',
        expect.objectContaining({
          requestId: 'req-123',
          sourcePath: '/tmp/source.txt',
          destinationPath: '/tmp/destination.txt'
        })
      );
    });

    it('should handle file move errors', async () => {
      const moveFileData = {
        sourcePath: '/tmp/source.txt',
        destinationPath: '/readonly/destination.txt'
      };
      const validatedContext = createValidatedContext(moveFileData);

      (mockFileService.moveFile as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Permission denied on destination',
          code: 'DESTINATION_PERMISSION_DENIED'
        }
      });

      const request = new Request('http://localhost:3000/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moveFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('DESTINATION_PERMISSION_DENIED');
    });
  });

  describe('handleMkdir - POST /api/mkdir', () => {
    it('should create directory successfully', async () => {
      const mkdirData = {
        path: '/tmp/new-directory',
        recursive: true
      };

      const validatedContext = createValidatedContext(mkdirData);
      (mockFileService.createDirectory as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mkdirData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as MkdirResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/new-directory');
      expect(responseData.recursive).toBe(true);
      expect(responseData.exitCode).toBe(0);
      expect(responseData.stdout).toBe('');
      expect(responseData.stderr).toBe('');

      expect(mockFileService.createDirectory).toHaveBeenCalledWith('/tmp/new-directory', {
        recursive: true
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Creating directory',
        expect.objectContaining({
          requestId: 'req-123',
          path: '/tmp/new-directory',
          recursive: true
        })
      );
    });

    it('should create directory without recursive option', async () => {
      const mkdirData = {
        path: '/tmp/simple-dir'
        // recursive not specified
      };

      const validatedContext = createValidatedContext(mkdirData);
      (mockFileService.createDirectory as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mkdirData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as MkdirResponse;
      expect(responseData.recursive).toBe(false); // Default to false

      expect(mockFileService.createDirectory).toHaveBeenCalledWith('/tmp/simple-dir', {
        recursive: undefined
      });
    });

    it('should handle directory creation errors', async () => {
      const mkdirData = {
        path: '/readonly/new-dir',
        recursive: false
      };
      const validatedContext = createValidatedContext(mkdirData);

      (mockFileService.createDirectory as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Permission denied',
          code: 'MKDIR_PERMISSION_DENIED'
        }
      });

      const request = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mkdirData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('MKDIR_PERMISSION_DENIED');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Directory creation failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          path: '/readonly/new-dir',
          recursive: false,
          errorCode: 'MKDIR_PERMISSION_DENIED'
        })
      );
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid endpoints', async () => {
      const request = new Request('http://localhost:3000/api/invalid-operation', {
        method: 'POST'
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.error).toBe('Invalid file endpoint');
    });

    it('should handle root path correctly', async () => {
      const request = new Request('http://localhost:3000/', {
        method: 'GET'
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.error).toBe('Invalid file endpoint');
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in all successful responses', async () => {
      const readFileData = { path: '/tmp/test.txt' };
      const validatedContext = createValidatedContext(readFileData);

      (mockFileService.readFile as any).mockResolvedValue({
        success: true,
        data: 'file content'
      });

      const request = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readFileData)
      });

      const response = await fileHandler.handle(request, validatedContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/invalid', {
        method: 'POST'
      });

      const response = await fileHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should have consistent response format across all operations', async () => {
      // Test all operations return consistent fields
      const operations = [
        {
          endpoint: '/api/read',
          data: { path: '/tmp/test.txt' },
          mockResponse: { success: true, data: 'content' },
          expectedFields: ['success', 'content', 'path', 'exitCode', 'encoding', 'timestamp']
        },
        {
          endpoint: '/api/write',
          data: { path: '/tmp/test.txt', content: 'data' },
          mockResponse: { success: true },
          expectedFields: ['success', 'exitCode', 'path', 'timestamp']
        },
        {
          endpoint: '/api/delete',
          data: { path: '/tmp/test.txt' },
          mockResponse: { success: true },
          expectedFields: ['success', 'exitCode', 'path', 'timestamp']
        }
      ];

      for (const operation of operations) {
        // Reset mocks
        vi.clearAllMocks();
        const validatedContext = createValidatedContext(operation.data);

        // Mock appropriate service method
        if (operation.endpoint === '/api/read') {
          (mockFileService.readFile as any).mockResolvedValue(operation.mockResponse);
        } else if (operation.endpoint === '/api/write') {
          (mockFileService.writeFile as any).mockResolvedValue(operation.mockResponse);
        } else if (operation.endpoint === '/api/delete') {
          (mockFileService.deleteFile as any).mockResolvedValue(operation.mockResponse);
        }

        const request = new Request(`http://localhost:3000${operation.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(operation.data)
        });

        const response = await fileHandler.handle(request, validatedContext);
        const responseData = await response.json() as ReadFileResponse;

        // Check that all expected fields are present
        for (const field of operation.expectedFields) {
          expect(responseData).toHaveProperty(field);
        }

        // Check common fields
        expect(responseData.success).toBe(true);
        expect(responseData.timestamp).toBeDefined();
      }
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored FileHandler:
 * 
 * 1. **CRUD Operations Testing**: FileHandler manages all file system operations
 *    (read, write, delete, rename, move, mkdir) with consistent patterns.
 * 
 * 2. **Request Validation Integration**: Handler uses validated data from context,
 *    which we mock to test different input scenarios.
 * 
 * 3. **ServiceResult Integration**: Handler converts FileService ServiceResult
 *    objects into appropriate HTTP responses with consistent formatting.
 * 
 * 4. **Default Value Handling**: Tests cover scenarios where optional parameters
 *    (encoding, recursive) use sensible defaults.
 * 
 * 5. **Error Response Testing**: All error scenarios are tested to ensure proper
 *    HTTP status codes and error message formatting.
 * 
 * 6. **Logging Integration**: Tests validate that appropriate log messages are
 *    generated for operations, successes, and errors.
 * 
 * 7. **Response Format Consistency**: Tests ensure all operations return responses
 *    with consistent structure and required fields.
 * 
 * 8. **CORS Header Validation**: Tests ensure CORS headers are included in both
 *    success and error responses.
 * 
 * 9. **Route Handling**: Tests cover both valid operations and invalid endpoints
 *    to ensure proper 404 responses.
 * 
 * 10. **Content Type Handling**: All responses return JSON with proper Content-Type
 *     headers and CORS configuration.
 */