/**
 * Process Handler Tests
 * 
 * Tests the ProcessHandler class from the refactored container architecture.
 * Demonstrates testing handlers with multiple endpoints and streaming functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessHandler } from '@container/handlers/process-handler';
import type { ProcessService } from '@container/services/process-service';
import type { Logger, RequestContext, ProcessInfo } from '@container/core/types';

// Mock the dependencies
const mockProcessService: ProcessService = {
  startProcess: vi.fn(),
  getProcess: vi.fn(),
  killProcess: vi.fn(),
  killAllProcesses: vi.fn(),
  listProcesses: vi.fn(),
  streamProcessLogs: vi.fn(),
  executeCommand: vi.fn(),
};

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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-456',
  validatedData: {}, // Will be set per test
};

describe('ProcessHandler', () => {
  let processHandler: ProcessHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the ProcessHandler (dynamic import)
    const { ProcessHandler: ProcessHandlerClass } = await import('@container/handlers/process-handler');
    processHandler = new ProcessHandlerClass(mockProcessService, mockLogger);
  });

  describe('handleStart - POST /api/process/start', () => {
    it('should start process successfully', async () => {
      const startProcessData = {
        command: 'echo "hello"',
        options: { cwd: '/tmp' }
      };

      const mockProcessInfo: ProcessInfo = {
        id: 'proc-123',
        pid: 12345,
        command: 'echo "hello"',
        status: 'running',
        startTime: new Date('2023-01-01T00:00:00Z'),
        sessionId: 'session-456',
        outputListeners: new Set(),
        statusListeners: new Set(),
      };

      // Set up mocks
      mockContext.validatedData = startProcessData;
      (mockProcessService.startProcess as any).mockResolvedValue({
        success: true,
        data: mockProcessInfo
      });

      const request = new Request('http://localhost:3000/api/process/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(startProcessData)
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.process.id).toBe('proc-123');
      expect(responseData.process.pid).toBe(12345);
      expect(responseData.process.command).toBe('echo "hello"');
      expect(responseData.process.status).toBe('running');
      expect(responseData.message).toBe('Process started successfully');

      // Verify service was called correctly
      expect(mockProcessService.startProcess).toHaveBeenCalledWith(
        'echo "hello"',
        { cwd: '/tmp' }
      );

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting process',
        expect.objectContaining({
          requestId: 'req-123',
          command: 'echo "hello"',
          options: { cwd: '/tmp' }
        })
      );
    });

    it('should handle process start failures', async () => {
      const startProcessData = { command: 'invalid-command' };
      mockContext.validatedData = startProcessData;

      (mockProcessService.startProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Command not found',
          code: 'COMMAND_NOT_FOUND',
          details: { command: 'invalid-command' }
        }
      });

      const request = new Request('http://localhost:3000/api/process/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(startProcessData)
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('COMMAND_NOT_FOUND');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Process start failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          command: 'invalid-command',
          errorCode: 'COMMAND_NOT_FOUND'
        })
      );
    });
  });

  describe('handleList - GET /api/process/list', () => {
    it('should list all processes successfully', async () => {
      const mockProcesses: ProcessInfo[] = [
        {
          id: 'proc-1',
          pid: 11111,
          command: 'sleep 10',
          status: 'running',
          startTime: new Date('2023-01-01T00:00:00Z'),
          sessionId: 'session-456',
          outputListeners: new Set(),
          statusListeners: new Set(),
        },
        {
          id: 'proc-2',
          pid: 22222,
          command: 'cat file.txt',
          status: 'completed',
          startTime: new Date('2023-01-01T00:01:00Z'),
          endTime: new Date('2023-01-01T00:01:30Z'),
          exitCode: 0,
          sessionId: 'session-456',
          outputListeners: new Set(),
          statusListeners: new Set(),
        }
      ];

      (mockProcessService.listProcesses as any).mockResolvedValue({
        success: true,
        data: mockProcesses
      });

      const request = new Request('http://localhost:3000/api/process/list', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.count).toBe(2);
      expect(responseData.processes).toHaveLength(2);
      expect(responseData.processes[0].id).toBe('proc-1');
      expect(responseData.processes[1].status).toBe('completed');

      expect(mockProcessService.listProcesses).toHaveBeenCalledWith({});
    });

    it('should filter processes by query parameters', async () => {
      (mockProcessService.listProcesses as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/process/list?sessionId=session-123&status=running', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      
      // Verify filtering parameters were passed to service
      expect(mockProcessService.listProcesses).toHaveBeenCalledWith({
        sessionId: 'session-123',
        status: 'running'
      });
    });

    it('should handle process listing errors', async () => {
      (mockProcessService.listProcesses as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Database error',
          code: 'DB_ERROR'
        }
      });

      const request = new Request('http://localhost:3000/api/process/list', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('DB_ERROR');
    });
  });

  describe('handleGet - GET /api/process/{id}', () => {
    it('should get process by ID successfully', async () => {
      const mockProcessInfo: ProcessInfo = {
        id: 'proc-123',
        pid: 12345,
        command: 'sleep 60',
        status: 'running',
        startTime: new Date('2023-01-01T00:00:00Z'),
        sessionId: 'session-456',
        stdout: 'Process output',
        stderr: 'Error output',
        outputListeners: new Set(),
        statusListeners: new Set(),
      };

      (mockProcessService.getProcess as any).mockResolvedValue({
        success: true,
        data: mockProcessInfo
      });

      const request = new Request('http://localhost:3000/api/process/proc-123', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.process.id).toBe('proc-123');
      expect(responseData.process.stdout).toBe('Process output');
      expect(responseData.process.stderr).toBe('Error output');

      expect(mockProcessService.getProcess).toHaveBeenCalledWith('proc-123');
    });

    it('should return 404 when process not found', async () => {
      (mockProcessService.getProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Process not found',
          code: 'PROCESS_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/process/nonexistent', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('PROCESS_NOT_FOUND');
    });
  });

  describe('handleKill - DELETE /api/process/{id}', () => {
    it('should kill process successfully', async () => {
      (mockProcessService.killProcess as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/process/proc-123', {
        method: 'DELETE'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('Process killed successfully');

      expect(mockProcessService.killProcess).toHaveBeenCalledWith('proc-123');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Process killed successfully',
        expect.objectContaining({
          requestId: 'req-123',
          processId: 'proc-123'
        })
      );
    });

    it('should handle kill failures', async () => {
      (mockProcessService.killProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Process already terminated',
          code: 'PROCESS_ALREADY_TERMINATED'
        }
      });

      const request = new Request('http://localhost:3000/api/process/proc-123', {
        method: 'DELETE'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error.code).toBe('PROCESS_ALREADY_TERMINATED');
    });
  });

  describe('handleKillAll - POST /api/process/kill-all', () => {
    it('should kill all processes successfully', async () => {
      (mockProcessService.killAllProcesses as any).mockResolvedValue({
        success: true,
        data: 3 // Number of killed processes
      });

      const request = new Request('http://localhost:3000/api/process/kill-all', {
        method: 'POST'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('All processes killed successfully');
      expect(responseData.killedCount).toBe(3);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'All processes killed successfully',
        expect.objectContaining({
          requestId: 'req-123',
          count: 3
        })
      );
    });

    it('should handle kill all failures', async () => {
      (mockProcessService.killAllProcesses as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Failed to kill processes',
          code: 'KILL_ALL_ERROR'
        }
      });

      const request = new Request('http://localhost:3000/api/process/kill-all', {
        method: 'POST'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.error.code).toBe('KILL_ALL_ERROR');
    });
  });

  describe('handleLogs - GET /api/process/{id}/logs', () => {
    it('should get process logs successfully', async () => {
      const mockProcessInfo: ProcessInfo = {
        id: 'proc-123',
        pid: 12345,
        command: 'echo test',
        status: 'completed',
        startTime: new Date('2023-01-01T00:00:00Z'),
        sessionId: 'session-456',
        stdout: 'test output',
        stderr: 'error output',
        outputListeners: new Set(),
        statusListeners: new Set(),
      };

      (mockProcessService.getProcess as any).mockResolvedValue({
        success: true,
        data: mockProcessInfo
      });

      const request = new Request('http://localhost:3000/api/process/proc-123/logs', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.processId).toBe('proc-123');
      expect(responseData.stdout).toBe('test output');
      expect(responseData.stderr).toBe('error output');
    });

    it('should handle logs request for nonexistent process', async () => {
      (mockProcessService.getProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Process not found',
          code: 'PROCESS_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/process/nonexistent/logs', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error.code).toBe('PROCESS_NOT_FOUND');
    });
  });

  describe('handleStream - GET /api/process/{id}/stream', () => {
    it('should create SSE stream for process logs', async () => {
      const mockProcessInfo: ProcessInfo = {
        id: 'proc-123',
        pid: 12345,
        command: 'long-running-command',
        status: 'running',
        startTime: new Date('2023-01-01T00:00:00Z'),
        sessionId: 'session-456',
        stdout: 'existing output',
        stderr: 'existing error',
        outputListeners: new Set(),
        statusListeners: new Set(),
      };

      (mockProcessService.streamProcessLogs as any).mockResolvedValue({
        success: true
      });
      (mockProcessService.getProcess as any).mockResolvedValue({
        success: true,
        data: mockProcessInfo
      });

      const request = new Request('http://localhost:3000/api/process/proc-123/stream', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Connection')).toBe('keep-alive');

      // Test streaming response body
      expect(response.body).toBeDefined();
      const reader = response.body!.getReader();
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain('process_info');
      expect(chunk).toContain('proc-123');
      expect(chunk).toContain('long-running-command');

      reader.releaseLock();
    });

    it('should handle stream setup failures', async () => {
      (mockProcessService.streamProcessLogs as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Stream setup failed',
          code: 'STREAM_ERROR'
        }
      });

      const request = new Request('http://localhost:3000/api/process/proc-123/stream', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error.code).toBe('STREAM_ERROR');
    });

    it('should handle process not found during stream setup', async () => {
      (mockProcessService.streamProcessLogs as any).mockResolvedValue({
        success: true
      });
      (mockProcessService.getProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Process not found for streaming',
          code: 'PROCESS_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/process/proc-123/stream', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error.code).toBe('PROCESS_NOT_FOUND');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Process stream setup failed - process not found',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          processId: 'proc-123'
        })
      );
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid endpoints', async () => {
      const request = new Request('http://localhost:3000/api/process/invalid-endpoint', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid process endpoint');
    });

    it('should handle malformed process ID paths', async () => {
      const request = new Request('http://localhost:3000/api/process/', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid process endpoint');
    });

    it('should handle unsupported HTTP methods for process endpoints', async () => {
      const request = new Request('http://localhost:3000/api/process/proc-123', {
        method: 'PUT' // Unsupported method
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid process endpoint');
    });

    it('should handle unsupported actions on process endpoints', async () => {
      const request = new Request('http://localhost:3000/api/process/proc-123/unsupported-action', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid process endpoint');
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in all responses', async () => {
      (mockProcessService.listProcesses as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/process/list', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/process/invalid', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored ProcessHandler:
 * 
 * 1. **RESTful Endpoint Testing**: The handler manages multiple HTTP endpoints
 *    (/start, /list, /{id}, /{id}/logs, /{id}/stream) with different methods.
 * 
 * 2. **Request Routing Testing**: Tests validate that URL parsing and routing
 *    work correctly for both static and dynamic routes.
 * 
 * 3. **ServiceResult Integration**: Handler converts ProcessService ServiceResult
 *    objects into appropriate HTTP responses with correct status codes.
 * 
 * 4. **Query Parameter Processing**: Tests cover filtering functionality through
 *    URL query parameters (sessionId, status).
 * 
 * 5. **Streaming Response Testing**: SSE streaming functionality is tested by
 *    validating response headers and initial stream content.
 * 
 * 6. **Error Response Testing**: All error scenarios are tested to ensure proper
 *    HTTP status codes and error message formatting.
 * 
 * 7. **Logging Integration**: Tests validate that appropriate log messages are
 *    generated for operations and errors.
 * 
 * 8. **CORS Header Validation**: Tests ensure CORS headers are included in both
 *    success and error responses.
 * 
 * 9. **Edge Case Handling**: Tests cover malformed URLs, unsupported methods,
 *    invalid endpoints, and various failure scenarios.
 */