import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
/**
 * Process Handler Tests
 *
 * Tests the ProcessHandler class from the refactored container architecture.
 * Demonstrates testing handlers with multiple endpoints and streaming functionality.
 */

import type { GetProcessResponse, HandlerErrorResponse, KillAllProcessesResponse, KillProcessResponse, ListProcessesResponse, Logger, ProcessInfo, ProcessLogsResponse, RequestContext, StartProcessResponse, ValidatedRequestContext } from '@sandbox-container/core/types.ts';
import type { ProcessHandler } from '@sandbox-container/handlers/process-handler.ts';
import type { ProcessService } from '@sandbox-container/services/process-service.ts';

// Mock the dependencies - use partial mock to avoid private property issues
const mockProcessService = {
  startProcess: vi.fn(),
  getProcess: vi.fn(),
  killProcess: vi.fn(),
  killAllProcesses: vi.fn(),
  listProcesses: vi.fn(),
  streamProcessLogs: vi.fn(),
  executeCommand: vi.fn(),
} as ProcessService;

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
};

// Helper to create validated context
const createValidatedContext = <T>(data: T): ValidatedRequestContext<T> => ({
  ...mockContext,
  validatedData: data
});

describe('ProcessHandler', () => {
  let processHandler: ProcessHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Import the ProcessHandler (dynamic import)
    const { ProcessHandler: ProcessHandlerClass } = await import('@sandbox-container/handlers/process-handler.ts');
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
        stdout: '',
        stderr: '',
        outputListeners: new Set(),
        statusListeners: new Set(),
      };

      const validatedContext = createValidatedContext(startProcessData);
      (mockProcessService.startProcess as any).mockResolvedValue({
        success: true,
        data: mockProcessInfo
      });

      const request = new Request('http://localhost:3000/api/process/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(startProcessData)
      });

      const response = await processHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as StartProcessResponse;
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
    });

    it('should handle process start failures', async () => {
      const startProcessData = { command: 'invalid-command' };
      const validatedContext = createValidatedContext(startProcessData);

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

      const response = await processHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('COMMAND_NOT_FOUND');
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
          stdout: '',
          stderr: '',
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
          stdout: '',
          stderr: '',
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
      const responseData = await response.json() as ListProcessesResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.count).toBe(2);
      expect(responseData.processes).toHaveLength(2);
      expect(responseData.processes[0].id).toBe('proc-1');
      expect(responseData.processes[1].status).toBe('completed');

      // Handler uses context.sessionId as fallback when no query params provided
      expect(mockProcessService.listProcesses).toHaveBeenCalledWith({
        sessionId: 'session-456'
      });
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('DB_ERROR');
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
      const responseData = await response.json() as GetProcessResponse;
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('PROCESS_NOT_FOUND');
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
      const responseData = await response.json() as KillProcessResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('Process killed successfully');

      expect(mockProcessService.killProcess).toHaveBeenCalledWith('proc-123');
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('PROCESS_ALREADY_TERMINATED');
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
      const responseData = await response.json() as KillAllProcessesResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('All processes killed successfully');
      expect(responseData.killedCount).toBe(3);
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('KILL_ALL_ERROR');
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
      const responseData = await response.json() as ProcessLogsResponse;
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('PROCESS_NOT_FOUND');
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('STREAM_ERROR');
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.code).toBe('PROCESS_NOT_FOUND');
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid endpoints', async () => {
      // Mock getProcess to return process not found for invalid process ID
      (mockProcessService.getProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Process not found',
          code: 'PROCESS_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/process/invalid-endpoint', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Process not found');
    });

    it('should handle malformed process ID paths', async () => {
      // Mock getProcess to return process not found for empty process ID
      (mockProcessService.getProcess as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Process not found',
          code: 'PROCESS_NOT_FOUND'
        }
      });

      const request = new Request('http://localhost:3000/api/process/', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Process not found');
    });

    it('should handle unsupported HTTP methods for process endpoints', async () => {
      const request = new Request('http://localhost:3000/api/process/proc-123', {
        method: 'PUT' // Unsupported method
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid process endpoint');
    });

    it('should handle unsupported actions on process endpoints', async () => {
      const request = new Request('http://localhost:3000/api/process/proc-123/unsupported-action', {
        method: 'GET'
      });

      const response = await processHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
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
