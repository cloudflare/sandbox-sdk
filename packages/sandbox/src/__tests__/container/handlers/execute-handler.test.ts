/**
 * Execute Handler Tests
 * 
 * Tests the ExecuteHandler class from the refactored container architecture.
 * This demonstrates how to test handlers with mocked service dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecuteHandler } from '@container/handlers/execute-handler';
import type { ProcessService } from '@container/services/process-service';
import type { RequestValidator } from '@container/validation/request-validator';
import type { Logger } from '@container/core/logger';
import type { RequestContext, ServiceResult } from '@container/core/types';

// Mock the service dependencies
const mockProcessService: ProcessService = {
  executeCommand: vi.fn(),
  startProcess: vi.fn(),
  getProcess: vi.fn(),
  killProcess: vi.fn(),
  listProcesses: vi.fn(),
  streamProcessLogs: vi.fn(),
};

const mockRequestValidator: RequestValidator = {
  validateExecuteRequest: vi.fn(),
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-456',
};

describe('ExecuteHandler', () => {
  let executeHandler: ExecuteHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the ExecuteHandler (dynamic import)
    const { ExecuteHandler: ExecuteHandlerClass } = await import('@container/handlers/execute-handler');
    executeHandler = new ExecuteHandlerClass(
      mockProcessService, 
      mockLogger, 
      mockRequestValidator
    );
  });

  describe('handle - Regular Execution', () => {
    it('should execute command successfully and return response', async () => {
      // Mock successful validation
      (mockRequestValidator.validateExecuteRequest as any).mockReturnValue({
        isValid: true,
        data: { command: 'echo "hello"', sessionId: 'session-456' }
      });

      // Mock successful command execution
      const mockCommandResult = {
        success: true,
        data: {
          exitCode: 0,
          stdout: 'hello\\n',
          stderr: '',
          duration: 100,
        }
      } as ServiceResult<any>;

      (mockProcessService.executeCommand as any).mockResolvedValue(mockCommandResult);

      // Execute the handler
      const response = await executeHandler.handle(
        { command: 'echo "hello"', sessionId: 'session-456' },
        mockContext
      );

      // Verify response
      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.data.exitCode).toBe(0);
      expect(responseData.data.stdout).toBe('hello\\n');

      // Verify service was called correctly
      expect(mockProcessService.executeCommand).toHaveBeenCalledWith(
        'echo "hello"',
        expect.objectContaining({
          sessionId: 'session-456'
        })
      );
    });

    it('should handle command execution errors', async () => {
      // Mock successful validation
      (mockRequestValidator.validateExecuteRequest as any).mockReturnValue({
        isValid: true,
        data: { command: 'nonexistent-command' }
      });

      // Mock command execution error
      const mockErrorResult = {
        success: false,
        error: {
          message: 'Command not found',
          code: 'COMMAND_ERROR'
        }
      } as ServiceResult<never>;

      (mockProcessService.executeCommand as any).mockResolvedValue(mockErrorResult);

      const response = await executeHandler.handle(
        { command: 'nonexistent-command' },
        mockContext
      );

      // Verify error response
      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('COMMAND_ERROR');
      expect(responseData.error.message).toBe('Command not found');
    });

    it('should handle validation errors', async () => {
      // Mock validation failure
      (mockRequestValidator.validateExecuteRequest as any).mockReturnValue({
        isValid: false,
        errors: ['Command cannot be empty']
      });

      const response = await executeHandler.handle(
        { command: '' },
        mockContext
      );

      // Verify validation error response
      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('VALIDATION_ERROR');
      expect(responseData.error.message).toContain('Command cannot be empty');

      // Verify service was not called
      expect(mockProcessService.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('handle - Background Execution', () => {
    it('should start background process successfully', async () => {
      // Mock successful validation
      (mockRequestValidator.validateExecuteRequest as any).mockReturnValue({
        isValid: true,
        data: { command: 'sleep 10', background: true }
      });

      // Mock successful process start
      const mockProcessResult = {
        success: true,
        data: {
          id: 'proc-123',
          command: 'sleep 10',
          status: 'running',
          startTime: new Date(),
          pid: 12345
        }
      } as ServiceResult<any>;

      (mockProcessService.startProcess as any).mockResolvedValue(mockProcessResult);

      const response = await executeHandler.handle(
        { command: 'sleep 10', background: true },
        mockContext
      );

      // Verify response
      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.data.process.id).toBe('proc-123');
      expect(responseData.data.process.status).toBe('running');

      // Verify service was called correctly
      expect(mockProcessService.startProcess).toHaveBeenCalledWith(
        'sleep 10',
        expect.objectContaining({
          background: true
        })
      );
    });
  });

  describe('handleStream - Streaming Execution', () => {
    it('should return streaming response for valid command', async () => {
      // Mock successful validation
      (mockRequestValidator.validateExecuteRequest as any).mockReturnValue({
        isValid: true,
        data: { command: 'echo "streaming test"' }
      });

      // Mock process service to return a readable stream
      const mockStream = new ReadableStream({
        start(controller) {
          // Simulate SSE events
          controller.enqueue('data: {"type":"start","timestamp":"2023-01-01T00:00:00Z"}\\n\\n');
          controller.enqueue('data: {"type":"stdout","data":"streaming test\\n","timestamp":"2023-01-01T00:00:01Z"}\\n\\n');
          controller.enqueue('data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:02Z"}\\n\\n');
          controller.close();
        }
      });

      (mockProcessService.executeCommandStream as any).mockResolvedValue(mockStream);

      const response = await executeHandler.handleStream(
        { command: 'echo "streaming test"' },
        mockContext
      );

      // Verify streaming response
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.body).toBeDefined();

      // Verify service was called
      expect(mockProcessService.executeCommandStream).toHaveBeenCalledWith(
        'echo "streaming test"',
        expect.any(Object)
      );
    });
  });
});

/**
 * This handler test demonstrates key patterns for the new architecture:
 * 
 * 1. **Handler-Service Separation**: Handlers orchestrate services but contain
 *    minimal business logic themselves.
 * 
 * 2. **ServiceResult Integration**: Handlers convert ServiceResult objects
 *    to HTTP responses with proper status codes.
 * 
 * 3. **Validation Integration**: Handlers use RequestValidator to validate
 *    inputs before passing to services.
 * 
 * 4. **Clean Mocking**: Service dependencies are easily mocked since they're
 *    injected via constructor.
 * 
 * 5. **Context Usage**: Handlers receive RequestContext with session info,
 *    CORS headers, and request tracing data.
 * 
 * 6. **Error Handling**: Both validation errors and service errors are
 *    handled consistently through the ServiceResult pattern.
 */