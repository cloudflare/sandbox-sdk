import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  ExecResult,
  ExecuteRequest,
  Logger,
  ProcessStartResult
} from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import type {
  RequestContext,
  ServiceResult
} from '@sandbox-container/core/types';
import { ExecuteHandler } from '@sandbox-container/handlers/execute-handler.js';
import type { ProcessService } from '@sandbox-container/services/process-service';
import { mocked } from '../test-utils';

// Mock the service dependencies
const mockProcessService = {
  executeCommand: vi.fn(),
  startProcess: vi.fn(),
  getProcess: vi.fn(),
  killProcess: vi.fn(),
  listProcesses: vi.fn()
} as unknown as ProcessService;

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

describe('ExecuteHandler', () => {
  let executeHandler: ExecuteHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    executeHandler = new ExecuteHandler(mockProcessService, mockLogger);
  });

  describe('handle - Regular Execution', () => {
    it('should execute command successfully and return response', async () => {
      // Mock successful command execution
      const mockCommandResult = {
        success: true,
        data: {
          success: true,
          exitCode: 0,
          stdout: 'hello\\n',
          stderr: '',
          duration: 100
        }
      } as ServiceResult<{
        success: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
        duration: number;
      }>;

      mocked(mockProcessService.executeCommand).mockResolvedValue(
        mockCommandResult
      );

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo "hello"',
          sessionId: 'session-456'
        })
      });

      const response = await executeHandler.handle(request, mockContext);

      // Verify response
      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ExecResult;
      expect(responseData.success).toBe(true);
      expect(responseData.exitCode).toBe(0);
      expect(responseData.stdout).toBe('hello\\n');
      expect(responseData.command).toBe('echo "hello"');
      expect(responseData.duration).toBeDefined();
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockProcessService.executeCommand).toHaveBeenCalledWith(
        'echo "hello"',
        expect.objectContaining({
          sessionId: 'session-456'
        })
      );
    });

    it('should handle command execution errors', async () => {
      // Mock successful service operation with failed command result
      const mockCommandResult = {
        success: true,
        data: {
          success: false, // Command failed
          exitCode: 1,
          stdout: '',
          stderr: 'command not found: nonexistent-command',
          duration: 50
        }
      } as ServiceResult<{
        success: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
        duration: number;
      }>;

      mocked(mockProcessService.executeCommand).mockResolvedValue(
        mockCommandResult
      );

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'nonexistent-command' })
      });

      const response = await executeHandler.handle(request, mockContext);

      // Verify response - service succeeded, command failed
      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ExecResult;
      expect(responseData.success).toBe(false); // Command failed
      expect(responseData.exitCode).toBe(1);
      expect(responseData.stderr).toContain('command not found');
      expect(responseData.command).toBe('nonexistent-command');
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle service failures (spawn errors)', async () => {
      // Mock actual service failure (e.g., spawn error)
      const mockServiceError = {
        success: false,
        error: {
          message: 'Failed to spawn process',
          code: 'PROCESS_ERROR'
        }
      } as ServiceResult<never>;

      mocked(mockProcessService.executeCommand).mockResolvedValue(
        mockServiceError
      );

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ls' })
      });

      const response = await executeHandler.handle(request, mockContext);

      // Verify error response for service failure - NEW format: {code, message, context, httpStatus}
      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('PROCESS_ERROR');
      expect(responseData.message).toContain('Failed to spawn process');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.context).toBeDefined();
    });

    // Test removed: ValidationMiddleware was deleted in Phase 0 of error consolidation
    // Handlers now parse request bodies directly using parseRequestBody()
    // Invalid JSON will be caught during parsing, not by missing validatedData
  });

  describe('handle - Background Execution', () => {
    it('should start background process successfully', async () => {
      const mockProcessResult = {
        success: true as const,
        data: {
          id: 'proc-123',
          command: 'sleep 10',
          status: 'running' as const,
          startTime: new Date(),
          pid: 12345,
          stdout: '',
          stderr: '',
          outputListeners: new Set<
            (stream: 'stdout' | 'stderr', data: string) => void
          >(),
          statusListeners: new Set<(status: string) => void>()
        }
      };

      mocked(mockProcessService.startProcess).mockResolvedValue(
        mockProcessResult
      );

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'sleep 10',
          background: true,
          sessionId: 'session-456'
        })
      });

      const response = await executeHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ProcessStartResult;
      expect(responseData.success).toBe(true);
      expect(responseData.processId).toBe('proc-123');
      expect(responseData.pid).toBe(12345);
      expect(responseData.command).toBe('sleep 10');
      expect(responseData.timestamp).toBeDefined();

      expect(mockProcessService.startProcess).toHaveBeenCalledWith(
        'sleep 10',
        expect.objectContaining({
          sessionId: 'session-456'
        })
      );
    });
  });

  describe('handleStream - Streaming Execution', () => {
    it('should return streaming response for valid command', async () => {
      // Mock process service to return a readable stream
      new ReadableStream({
        start(controller) {
          // Simulate SSE events
          controller.enqueue(
            'data: {"type":"start","timestamp":"2023-01-01T00:00:00Z"}\\n\\n'
          );
          controller.enqueue(
            'data: {"type":"stdout","data":"streaming test\\n","timestamp":"2023-01-01T00:00:01Z"}\\n\\n'
          );
          controller.enqueue(
            'data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:02Z"}\\n\\n'
          );
          controller.close();
        }
      });

      // Mock successful process start for streaming
      const mockStreamProcessResult = {
        success: true as const,
        data: {
          id: 'stream-proc-123',
          command: 'echo "streaming test"',
          status: 'running' as const,
          startTime: new Date(),
          pid: 12345,
          stdout: '',
          stderr: '',
          outputListeners: new Set<
            (stream: 'stdout' | 'stderr', data: string) => void
          >(),
          statusListeners: new Set<(status: string) => void>()
        }
      };

      mocked(mockProcessService.startProcess).mockResolvedValue(
        mockStreamProcessResult
      );

      const request = new Request('http://localhost:3000/api/execute/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "streaming test"' })
      });

      const response = await executeHandler.handle(request, mockContext);

      // Verify streaming response
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.body).toBeDefined();

      // Verify service was called
      expect(mockProcessService.startProcess).toHaveBeenCalledWith(
        'echo "streaming test"',
        expect.any(Object)
      );
    });

    /**
     * Test for GitHub issue #13442: Stream controller race condition
     *
     * The execute/stream endpoint uses the same streaming pattern as
     * process/stream and has the same vulnerability to race conditions.
     */
    it('should handle stream cancellation without controller errors', async () => {
      const outputListeners = new Set<
        (stream: 'stdout' | 'stderr', data: string) => void
      >();
      const statusListeners = new Set<(status: string) => void>();

      let capturedOutputListener:
        | ((stream: 'stdout' | 'stderr', data: string) => void)
        | undefined;
      let capturedStatusListener: ((status: string) => void) | undefined;

      const mockStreamProcessResult = {
        success: true as const,
        data: {
          id: 'exec-stream-race',
          command: 'echo "race test"',
          status: 'running' as const,
          startTime: new Date(),
          pid: 55555,
          stdout: 'initial',
          stderr: '',
          outputListeners,
          statusListeners
        }
      };

      // Intercept listener registration
      const originalOutputAdd = outputListeners.add.bind(outputListeners);
      outputListeners.add = (fn: any) => {
        capturedOutputListener = fn;
        return originalOutputAdd(fn);
      };

      const originalStatusAdd = statusListeners.add.bind(statusListeners);
      statusListeners.add = (fn: any) => {
        capturedStatusListener = fn;
        return originalStatusAdd(fn);
      };

      mocked(mockProcessService.startProcess).mockResolvedValue(
        mockStreamProcessResult
      );

      const request = new Request('http://localhost:3000/api/execute/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "race test"' })
      });

      const response = await executeHandler.handle(request, mockContext);
      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();

      const reader = response.body!.getReader();
      await reader.read(); // Let listeners register

      // Cancel the stream
      await reader.cancel();

      // Simulate race condition: callbacks fire after cancel
      expect(() => {
        if (capturedOutputListener) {
          capturedOutputListener('stdout', 'late output');
        }
        if (capturedStatusListener) {
          capturedStatusListener('completed');
        }
      }).not.toThrow();
    });
  });
});
