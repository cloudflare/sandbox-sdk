/**
 * Execute Handler Tests
 * 
 * Tests the ExecuteHandler class from the refactored container architecture.
 * This demonstrates how to test handlers with mocked service dependencies.
 */

import type { ExecuteRequest, ExecuteResponse, Logger, RequestContext, ServiceResult, ValidatedRequestContext } from '@container/core/types';
import type { ExecuteHandler } from '@container/handlers/execute-handler';
import type { ProcessService } from '@container/services/process-service';
import type { SessionService } from '@container/services/session-service';
import type { ContainerErrorResponse } from '@container/utils/error-mapping';

// Mock the service dependencies
const mockProcessService = {
  executeCommand: vi.fn(),
  startProcess: vi.fn(),
  getProcess: vi.fn(),
  killProcess: vi.fn(),
  listProcesses: vi.fn(),
  streamProcessLogs: vi.fn(),
} as ProcessService;

const mockSessionService = {
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
} as SessionService;

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

  // Helper to create context with validated data
  const createValidatedContext = (data: ExecuteRequest): ValidatedRequestContext<ExecuteRequest> => ({
    ...mockContext,
    validatedData: data
  });

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the ExecuteHandler (dynamic import)
    const { ExecuteHandler: ExecuteHandlerClass } = await import('@container/handlers/execute-handler');
    executeHandler = new ExecuteHandlerClass(
      mockProcessService, 
      mockLogger
    );
  });

  describe('handle - Regular Execution', () => {
    it('should execute command successfully and return response', async () => {
      // Test assumes validation already occurred and data is in context

      // Mock successful command execution
      const mockCommandResult = {
        success: true,
        data: {
          success: true,
          exitCode: 0,
          stdout: 'hello\\n',
          stderr: ''
        }
      } as ServiceResult<{ success: boolean; exitCode: number; stdout: string; stderr: string; }>;

      vi.mocked(mockProcessService.executeCommand).mockResolvedValue(mockCommandResult);

      // Execute the handler with properly validated context
      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "hello"', sessionId: 'session-456' })
      });
      const validatedContext = createValidatedContext({ 
        command: 'echo "hello"', 
        sessionId: 'session-456' 
      });
      
      const response = await executeHandler.handle(request, validatedContext);

      // Verify response
      expect(response.status).toBe(200);
      const responseData = await response.json() as ExecuteResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.exitCode).toBe(0);
      expect(responseData.stdout).toBe('hello\\n');

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
          stderr: 'command not found: nonexistent-command'
        }
      } as ServiceResult<{ success: boolean; exitCode: number; stdout: string; stderr: string; }>;

      vi.mocked(mockProcessService.executeCommand).mockResolvedValue(mockCommandResult);

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'nonexistent-command' })
      });
      const validatedContext = createValidatedContext({ 
        command: 'nonexistent-command' 
      });
      const response = await executeHandler.handle(request, validatedContext);

      // Verify response - service succeeded, command failed
      expect(response.status).toBe(200);
      const responseData = await response.json() as ExecuteResponse;
      expect(responseData.success).toBe(false); // Command failed
      expect(responseData.exitCode).toBe(1);
      expect(responseData.stderr).toContain('command not found');
    });

    it('should handle service failures (spawn errors)', async () => {
      // Mock actual service failure (e.g., spawn error)
      const mockServiceError = {
        success: false,
        error: {
          message: 'Failed to spawn process',
          code: 'SPAWN_ERROR'
        }
      } as ServiceResult<never>;

      vi.mocked(mockProcessService.executeCommand).mockResolvedValue(mockServiceError);

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'ls' })
      });
      const validatedContext = createValidatedContext({ 
        command: 'ls' 
      });
      const response = await executeHandler.handle(request, validatedContext);

      // Verify error response for service failure
      expect(response.status).toBe(400);
      const responseData = await response.json() as ContainerErrorResponse;
      expect(responseData.code).toBe('SPAWN_ERROR');
      expect(responseData.error).toContain('Failed to spawn process');
    });

    it('should handle missing validation data (middleware failure)', async () => {
      // Test what happens when validation middleware fails to provide data
      // This simulates a middleware error where no validatedData is set

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo test' })
      });
      
      // Use context without validatedData to simulate middleware failure
      try {
        await executeHandler.handle(request, mockContext);
        expect.fail('Handler should throw when no validated data is provided');
      } catch (error) {
        expect((error as Error).message).toContain('No validated data found in context');
      }

      // Verify service was not called
      expect(mockProcessService.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('handle - Background Execution', () => {
    it('should start background process successfully', async () => {
      // Mock successful validation
      // Test assumes validation already occurred and data is in context

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
      } as ServiceResult<{ id: string; command: string; status: string; startTime: Date; pid: number; }>;

      vi.mocked(mockProcessService.startProcess).mockResolvedValue(mockProcessResult);

      const request = new Request('http://localhost:3000/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'sleep 10', background: true })
      });
      const validatedContext = createValidatedContext({ 
        command: 'sleep 10', 
        background: true,
        sessionId: 'session-456'
      });
      const response = await executeHandler.handle(request, validatedContext);

      // Verify response
      expect(response.status).toBe(200);
      const responseData = await response.json() as ExecuteResponse;
      expect(responseData.success).toBe(true);
      expect(responseData.processId).toBe('proc-123');
      // Background process response includes processId

      // Verify service was called correctly
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
      // Mock successful validation
      // Test assumes validation already occurred and data is in context

      // Mock process service to return a readable stream
      new ReadableStream({
        start(controller) {
          // Simulate SSE events
          controller.enqueue('data: {"type":"start","timestamp":"2023-01-01T00:00:00Z"}\\n\\n');
          controller.enqueue('data: {"type":"stdout","data":"streaming test\\n","timestamp":"2023-01-01T00:00:01Z"}\\n\\n');
          controller.enqueue('data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:02Z"}\\n\\n');
          controller.close();
        }
      });

      // Mock successful process start for streaming
      const mockStreamProcessResult = {
        success: true,
        data: {
          id: 'stream-proc-123',
          command: 'echo "streaming test"',
          status: 'running',
          startTime: new Date(),
          pid: 12345,
          outputListeners: new Set(),
          statusListeners: new Set()
        }
      } as ServiceResult<{ id: string; command: string; status: string; startTime: Date; pid: number; outputListeners: Set<any>; statusListeners: Set<any>; }>;

      vi.mocked(mockProcessService.startProcess).mockResolvedValue(mockStreamProcessResult);

      const request = new Request('http://localhost:3000/api/execute/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "streaming test"' })
      });
      const validatedContext = createValidatedContext({ 
        command: 'echo "streaming test"'
      });
      const response = await executeHandler.handle(request, validatedContext);

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