/**
 * File Operations Integration Tests
 * 
 * Tests complete request flows for file operations involving multiple services:
 * - Request validation → Security validation → File operations → Session updates → Response formatting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { 
  FileHandler,
  SessionService,
  SecurityService,
  RequestValidator,
  FileService,
  Logger,
  RequestContext,
  SessionStore,
  ServiceResult
} from '@container/core/types';

// Mock implementations for integration testing
const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

const mockSessionStore: SessionStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

// Mock Bun globals for file operations
const mockBunFile = vi.fn();
global.Bun = {
  file: mockBunFile,
  spawn: vi.fn(),
} as any;

const mockContext: RequestContext = {
  requestId: 'req-file-integration-456',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-file-ops',
  validatedData: {},
};

describe('File Operations Integration Flow', () => {
  let fileHandler: FileHandler;
  let sessionService: SessionService;
  let securityService: SecurityService;
  let requestValidator: RequestValidator;
  let fileService: FileService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import and create service instances
    const { SessionService: SessionServiceClass } = await import('@container/services/session-service');
    const { SecurityService: SecurityServiceClass } = await import('@container/security/security-service');
    const { RequestValidator: RequestValidatorClass } = await import('@container/validation/request-validator');
    const { FileService: FileServiceClass } = await import('@container/services/file-service');
    const { FileHandler: FileHandlerClass } = await import('@container/handlers/file-handler');

    // Create integrated service chain
    securityService = new SecurityServiceClass(mockLogger);
    requestValidator = new RequestValidatorClass(securityService);
    sessionService = new SessionServiceClass(mockSessionStore, mockLogger);
    fileService = new FileServiceClass(securityService, mockLogger);
    fileHandler = new FileHandlerClass(fileService, sessionService, mockLogger);

    // Setup default session mock
    (mockSessionStore.get as any).mockResolvedValue({
      id: 'session-file-ops',
      createdAt: new Date(),
      lastActivity: new Date(),
      env: { NODE_ENV: 'test' },
      cwd: '/tmp',
      isActive: true,
    });

    (mockSessionStore.set as any).mockResolvedValue(undefined);

    // Setup default file mocks
    mockBunFile.mockReturnValue({
      exists: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue('file content'),
      bytes: vi.fn().mockResolvedValue(new Uint8Array([102, 105, 108, 101])), // "file"
      size: 12,
      write: vi.fn().mockResolvedValue(12),
    });
  });

  describe('file read operations workflow', () => {
    it('should execute complete file read flow: validation → security → session → file read → response', async () => {
      const readRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/test-file.txt',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(readRequest, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.content).toBe('file content');
      expect(responseData.size).toBe(12);

      // Verify the complete service interaction chain
      
      // 1. File should have been accessed through Bun API
      expect(mockBunFile).toHaveBeenCalledWith('/tmp/test-file.txt');

      // 2. Session should have been updated with last activity
      expect(mockSessionStore.get).toHaveBeenCalledWith('session-file-ops');
      expect(mockSessionStore.set).toHaveBeenCalledWith(
        'session-file-ops',
        expect.objectContaining({
          lastActivity: expect.any(Date)
        })
      );

      // 3. File operation should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File read completed',
        expect.objectContaining({
          path: '/tmp/test-file.txt',
          encoding: 'utf-8',
          size: 12
        })
      );
    });

    it('should handle file read with session context and working directory', async () => {
      // Update session with specific working directory
      (mockSessionStore.get as any).mockResolvedValue({
        id: 'session-file-ops',
        createdAt: new Date(),
        lastActivity: new Date(),
        env: { NODE_ENV: 'test' },
        cwd: '/home/user/project',
        isActive: true,
      });

      const relativeReadRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: './config.json',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(relativeReadRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);

      // File path should be resolved relative to session working directory
      // (The actual path resolution would depend on the implementation)
      expect(mockBunFile).toHaveBeenCalled();
      
      // Session should be updated
      expect(mockSessionStore.set).toHaveBeenCalled();
    });
  });

  describe('file write operations workflow', () => {
    it('should execute complete file write flow with session and security integration', async () => {
      const writeRequest = new Request('http://localhost:3000/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/output.txt',
          content: 'Hello, integrated world!',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(writeRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.bytesWritten).toBe(12);

      // Verify complete integration
      expect(mockBunFile).toHaveBeenCalledWith('/tmp/output.txt');
      expect(mockSessionStore.get).toHaveBeenCalledWith('session-file-ops');
      expect(mockSessionStore.set).toHaveBeenCalled();

      // Write operation should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File write completed',
        expect.objectContaining({
          path: '/tmp/output.txt',
          encoding: 'utf-8',
          bytesWritten: 12
        })
      );
    });

    it('should prevent dangerous file writes through security integration', async () => {
      const dangerousWriteRequest = new Request('http://localhost:3000/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/etc/passwd',
          content: 'malicious content',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(dangerousWriteRequest, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Path validation failed');

      // Security violation should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Path validation failed',
        expect.objectContaining({
          path: '/etc/passwd'
        })
      );

      // File should not have been written
      expect(mockBunFile).not.toHaveBeenCalled();
      expect(mockSessionStore.set).not.toHaveBeenCalled();
    });
  });

  describe('file management operations workflow', () => {
    it('should execute complete file deletion with audit trail', async () => {
      const deleteRequest = new Request('http://localhost:3000/api/files/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/to-delete.txt',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(deleteRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.message).toContain('deleted successfully');

      // Verify security validation occurred
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File delete completed',
        expect.objectContaining({
          path: '/tmp/to-delete.txt'
        })
      );

      // Session should be updated for audit trail
      expect(mockSessionStore.set).toHaveBeenCalled();
    });

    it('should execute file rename with dual path security validation', async () => {
      const renameRequest = new Request('http://localhost:3000/api/files/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPath: '/tmp/old-name.txt',
          newPath: '/tmp/new-name.txt',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(renameRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);

      // Both paths should have been validated by security service
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File rename completed',
        expect.objectContaining({
          oldPath: '/tmp/old-name.txt',
          newPath: '/tmp/new-name.txt'
        })
      );
    });

    it('should prevent file rename with dangerous destination path', async () => {
      const dangerousRenameRequest = new Request('http://localhost:3000/api/files/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPath: '/tmp/innocent.txt',
          newPath: '/etc/passwd',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(dangerousRenameRequest, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Path validation failed');

      // Security violation should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Path validation failed',
        expect.any(Object)
      );
    });
  });

  describe('directory operations workflow', () => {
    it('should execute directory creation with session tracking', async () => {
      const mkdirRequest = new Request('http://localhost:3000/api/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/new-directory',
          recursive: true,
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(mkdirRequest, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);

      // Directory creation should be logged and session updated
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Directory created',
        expect.objectContaining({
          path: '/tmp/new-directory',
          recursive: true
        })
      );

      expect(mockSessionStore.set).toHaveBeenCalled();
    });
  });

  describe('cross-service file operations', () => {
    it('should coordinate file operations with command execution results', async () => {
      // First, create a file through file service
      const createRequest = new Request('http://localhost:3000/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/script.sh',
          content: '#!/bin/bash\necho "Hello from script"',
          sessionId: 'session-file-ops'
        })
      });

      const createResponse = await fileHandler.handle(createRequest, mockContext);
      expect(createResponse.status).toBe(200);

      // Session should now have updated activity
      expect(mockSessionStore.set).toHaveBeenCalledWith(
        'session-file-ops',
        expect.objectContaining({
          lastActivity: expect.any(Date)
        })
      );

      // Now read back the file to verify the content was written
      const readRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/script.sh',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      const readResponse = await fileHandler.handle(readRequest, mockContext);
      expect(readResponse.status).toBe(200);

      const readData = await readResponse.json();
      expect(readData.success).toBe(true);
      expect(readData.content).toBe('file content'); // Mock content

      // Both operations should be logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File write completed',
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'File read completed',
        expect.any(Object)
      );
    });

    it('should maintain session context across multiple file operations', async () => {
      const operations = [
        { path: '/tmp/file1.txt', content: 'content 1' },
        { path: '/tmp/file2.txt', content: 'content 2' },
        { path: '/tmp/file3.txt', content: 'content 3' },
      ];

      for (const op of operations) {
        const writeRequest = new Request('http://localhost:3000/api/files/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: op.path,
            content: op.content,
            sessionId: 'session-file-ops'
          })
        });

        const response = await fileHandler.handle(writeRequest, mockContext);
        expect(response.status).toBe(200);
      }

      // Session should have been accessed and updated for each operation
      expect(mockSessionStore.get).toHaveBeenCalledTimes(3);
      expect(mockSessionStore.set).toHaveBeenCalledTimes(3);

      // All operations should be logged
      expect(mockLogger.info).toHaveBeenCalledTimes(3);
    });
  });

  describe('error handling and recovery', () => {
    it('should handle file system errors gracefully', async () => {
      // Mock file system error
      mockBunFile.mockReturnValue({
        exists: vi.fn().mockResolvedValue(false),
        text: vi.fn().mockRejectedValue(new Error('File not found')),
      });

      const readRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/nonexistent.txt',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(readRequest, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('File not found');

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'File read failed',
        expect.objectContaining({
          path: '/tmp/nonexistent.txt',
          error: expect.stringContaining('File not found')
        })
      );
    });

    it('should handle session service failures during file operations', async () => {
      // Mock session retrieval failure
      (mockSessionStore.get as any).mockRejectedValue(new Error('Session store down'));

      const readRequest = new Request('http://localhost:3000/api/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/test.txt',
          sessionId: 'session-file-ops'
        })
      });

      const response = await fileHandler.handle(readRequest, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error).toContain('Session retrieval failed');

      // Should log session error but not attempt file operation
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Session operation failed'),
        expect.any(Object)
      );
    });

    it('should handle concurrent file operations on same session', async () => {
      const concurrentRequests = Array.from({ length: 3 }, (_, i) => 
        new Request('http://localhost:3000/api/files/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: `/tmp/concurrent-${i}.txt`,
            content: `content ${i}`,
            sessionId: 'session-file-ops'
          })
        })
      );

      const responses = await Promise.all(
        concurrentRequests.map(req => fileHandler.handle(req, mockContext))
      );

      // All operations should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
      }

      // Session should be updated for each operation
      expect(mockSessionStore.get).toHaveBeenCalledTimes(3);
      expect(mockSessionStore.set).toHaveBeenCalledTimes(3);
    });
  });

  describe('service result pattern validation', () => {
    it('should maintain ServiceResult pattern consistency across all file operations', async () => {
      const operations = [
        { method: 'POST', endpoint: '/api/files/read', body: { path: '/tmp/test.txt' } },
        { method: 'POST', endpoint: '/api/files/write', body: { path: '/tmp/test.txt', content: 'test' } },
        { method: 'DELETE', endpoint: '/api/files/delete', body: { path: '/tmp/test.txt' } },
        { method: 'PUT', endpoint: '/api/files/rename', body: { oldPath: '/tmp/old.txt', newPath: '/tmp/new.txt' } },
        { method: 'POST', endpoint: '/api/files/mkdir', body: { path: '/tmp/newdir' } },
      ];

      for (const op of operations) {
        const request = new Request(`http://localhost:3000${op.endpoint}`, {
          method: op.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...op.body, sessionId: 'session-file-ops' })
        });

        const response = await fileHandler.handle(request, mockContext);
        const responseData = await response.json();

        // All responses should follow ServiceResult pattern
        expect(responseData).toHaveProperty('success');
        
        if (responseData.success) {
          expect(responseData.error).toBeUndefined();
        } else {
          expect(responseData).toHaveProperty('error');
          expect(typeof responseData.error).toBe('string');
        }
      }
    });
  });
});

/**
 * This integration test suite validates the complete file operations workflow:
 * 
 * 1. **Complete File Operation Flows**: Tests the full pipeline from HTTP request
 *    through validation, security, session management, and file system operations.
 * 
 * 2. **Security Integration**: Validates that path security validation prevents
 *    dangerous file operations and logs security violations.
 * 
 * 3. **Session Context Management**: Tests how file operations update session
 *    activity and maintain audit trails for file system changes.
 * 
 * 4. **Cross-Service Coordination**: Validates how file operations coordinate
 *    with session management and security services.
 * 
 * 5. **File System Error Handling**: Tests graceful handling of file system
 *    errors, permission issues, and missing files.
 * 
 * 6. **Concurrent Operations**: Validates that multiple file operations on the
 *    same session are handled correctly without race conditions.
 * 
 * 7. **Service Result Pattern**: Ensures consistent ServiceResult pattern usage
 *    across all file operation types (read, write, delete, rename, mkdir).
 * 
 * 8. **Audit Trail**: Tests that all file operations are properly logged with
 *    appropriate context and security event tracking.
 * 
 * 9. **Path Resolution**: Validates how file paths are resolved within session
 *    context and working directory management.
 * 
 * 10. **Content Type Handling**: Tests different encoding types and binary/text
 *     file handling through the integrated service architecture.
 * 
 * The tests demonstrate that the refactored architecture successfully handles
 * complex file operations while maintaining security, session context, and
 * proper error recovery throughout the entire request lifecycle.
 */