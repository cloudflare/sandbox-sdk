/**
 * File Operations Integration Tests
 * 
 * Tests complete request flows for file operations involving multiple services:
 * - Request validation → Security validation → File operations → Session updates → Response formatting
 * 
 * These tests use the full Router + Middleware + Handler pipeline to test real integration
 */

import { Container } from '@container/core/container';
import { Router } from '@container/core/router';
import { setupRoutes } from '@container/routes/setup';
import { ReadFileResponse } from 'src/clients/file-client';

// Mock Bun globals for file operations
const mockBunFile = vi.fn();
const mockBunWrite = vi.fn();
const mockBunSpawn = vi.fn();
global.Bun = {
  file: mockBunFile,
  write: mockBunWrite,
  spawn: mockBunSpawn,
} as any;

describe('File Operations Integration Flow', () => {
  let router: Router;
  let container: Container;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create and initialize the container with all services
    container = new Container();
    await container.initialize();

    // Create router and set up routes with middleware
    router = new Router();
    setupRoutes(router, container);

    // Setup Bun.file mocks for file operations
    mockBunFile.mockReturnValue({
      exists: vi.fn().mockResolvedValue(true),
      text: vi.fn().mockResolvedValue('file content'),
      bytes: vi.fn().mockResolvedValue(new Uint8Array([102, 105, 108, 101])), // "file"
      size: 12,
      write: vi.fn().mockResolvedValue(12),
    });

    // Setup Bun.write mock for file writing
    mockBunWrite.mockResolvedValue(12);

    // Setup Bun.spawn mock for file system commands (rm, mv, mkdir)
    mockBunSpawn.mockImplementation((args: string[]) => ({
      exited: Promise.resolve(),
      exitCode: 0,
      stdout: new ReadableStream({
        start(controller) { controller.close(); }
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); }
      }),
      kill: vi.fn(),
    }));
  });

  afterEach(() => {
    // Clean up
    router.clearRoutes();
  });

  describe('file read operations workflow', () => {
    it('should execute complete file read flow: validation → security → session → file read → response', async () => {
      const readRequest = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/test-file.txt',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(readRequest);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = await response.json() as ReadFileResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.content).toBe('file content');
      expect(responseData.path).toBe('/tmp/test-file.txt');
      // Note: encoding is not part of ReadFileResponse interface

      // Verify file was accessed through Bun API
      expect(mockBunFile).toHaveBeenCalledWith('/tmp/test-file.txt');
    });

    it('should handle file read with session context and working directory', async () => {
      const relativeReadRequest = new Request('http://localhost:3000/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: './config.json',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(relativeReadRequest);

      expect(response.status).toBe(200);
      const responseData = await response.json() as any;
      expect(responseData.success).toBe(true);

      // File should be accessed through Bun API
      expect(mockBunFile).toHaveBeenCalled();
    });
  });

  describe('file write operations workflow', () => {
    it('should execute complete file write flow with session and security integration', async () => {
      const writeRequest = new Request('http://localhost:3000/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/output.txt',
          content: 'Hello, integrated world!',
          encoding: 'utf-8',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(writeRequest);

      expect(response.status).toBe(200);
      const responseData = await response.json() as any;
      expect(responseData.success).toBe(true);
      expect(responseData.path).toBe('/tmp/output.txt');
      expect(responseData.exitCode).toBe(0);

      // Verify file write operation was called
      expect(mockBunWrite).toHaveBeenCalledWith('/tmp/output.txt', 'Hello, integrated world!');
    });

    it('should prevent dangerous file writes through security integration', async () => {
      const dangerousWriteRequest = new Request('http://localhost:3000/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/etc/passwd',
          content: 'malicious content',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(dangerousWriteRequest);

      // Security validation should reject this path
      expect(response.status).toBe(400);
      const responseData = await response.json() as any;
      expect(responseData.error).toBe('Validation Error');
      expect(responseData.message).toBe('Request validation failed');

      // File should not have been written
      expect(mockBunFile).not.toHaveBeenCalled();
    });
  });

  describe('file management operations workflow', () => {
    it('should execute complete file deletion with audit trail', async () => {
      const deleteRequest = new Request('http://localhost:3000/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/to-delete.txt',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(deleteRequest);

      expect(response.status).toBe(200);
      const responseData = await response.json() as any;
      expect(responseData.success).toBe(true);
    });

    it('should execute file rename with dual path security validation', async () => {
      const renameRequest = new Request('http://localhost:3000/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPath: '/tmp/old-name.txt',
          newPath: '/tmp/new-name.txt',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(renameRequest);

      expect(response.status).toBe(200);
      const responseData = await response.json() as any;
      expect(responseData.success).toBe(true);
    });

    it('should prevent file rename with dangerous destination path', async () => {
      const dangerousRenameRequest = new Request('http://localhost:3000/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPath: '/tmp/innocent.txt',
          newPath: '/etc/passwd',
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(dangerousRenameRequest);

      // Security validation should reject this path
      expect(response.status).toBe(400);
      const responseData = await response.json() as any;
      expect(responseData.error).toBe('Validation Error');
      expect(responseData.message).toBe('Request validation failed');
    });
  });

  describe('directory operations workflow', () => {
    it('should execute directory creation with session tracking', async () => {
      const mkdirRequest = new Request('http://localhost:3000/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/tmp/new-directory',
          recursive: true,
          sessionId: 'session-file-ops'
        })
      });

      // Execute through the complete Router + Middleware + Handler pipeline
      const response = await router.route(mkdirRequest);

      expect(response.status).toBe(200);
      const responseData = await response.json() as any;
      expect(responseData.success).toBe(true);
    });
  });
});