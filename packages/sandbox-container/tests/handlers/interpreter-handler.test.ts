import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  ContextCreateResult,
  ContextDeleteResult,
  ContextListResult,
  InterpreterHealthResult
} from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type {
  Logger,
  RequestContext,
  ServiceResult
} from '@sandbox-container/core/types.ts';
import { InterpreterHandler } from '@sandbox-container/handlers/interpreter-handler.js';
import type {
  CreateContextRequest,
  InterpreterService
} from '@sandbox-container/services/interpreter-service.ts';
import { mocked } from '../test-utils';

// Mock the service dependencies
const mockInterpreterService = {
  getHealthStatus: vi.fn(),
  createContext: vi.fn(),
  listContexts: vi.fn(),
  deleteContext: vi.fn(),
  executeCode: vi.fn()
} as unknown as InterpreterService;

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn()
};

// Mock request context
const mockContext: RequestContext = {
  requestId: 'req-123',
  timestamp: new Date(),
  corsHeaders: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  },
  sessionId: 'session-456'
};

describe('InterpreterHandler', () => {
  let interpreterHandler: InterpreterHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    interpreterHandler = new InterpreterHandler(
      mockInterpreterService,
      mockLogger
    );
  });

  describe('handle - Health Check', () => {
    it('should return healthy status when interpreter is ready', async () => {
      // Mock successful health check
      const mockHealthResult = {
        success: true,
        data: {
          status: 'healthy',
          ready: true,
          version: '1.0.0'
        }
      } as ServiceResult<{ status: string; ready: boolean; version: string }>;

      mocked(mockInterpreterService.getHealthStatus).mockResolvedValue(
        mockHealthResult
      );

      const request = new Request(
        'http://localhost:3000/api/interpreter/health',
        {
          method: 'GET'
        }
      );

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify success response: {success: true, status, timestamp}
      expect(response.status).toBe(200);
      const responseData = (await response.json()) as InterpreterHealthResult;
      expect(responseData.success).toBe(true);
      expect(responseData.status).toBe('healthy');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called
      expect(mockInterpreterService.getHealthStatus).toHaveBeenCalled();
    });

    it('should return error when health check fails', async () => {
      // Mock health check failure
      const mockHealthError = {
        success: false,
        error: {
          message: 'Interpreter not initialized',
          code: 'INTERPRETER_NOT_READY',
          details: { retryAfter: 5 }
        }
      } as ServiceResult<never>;

      mocked(mockInterpreterService.getHealthStatus).mockResolvedValue(
        mockHealthError
      );

      const request = new Request(
        'http://localhost:3000/api/interpreter/health',
        {
          method: 'GET'
        }
      );

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response: {code, message, context, httpStatus, timestamp}
      expect(response.status).toBeGreaterThanOrEqual(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('INTERPRETER_NOT_READY');
      expect(responseData.message).toBe('Interpreter not initialized');
      expect(responseData.context).toBeDefined();
      expect(responseData.httpStatus).toBeDefined();
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - Create Context', () => {
    it('should create context successfully', async () => {
      // Mock successful context creation
      const mockContextResult = {
        success: true,
        data: {
          id: 'ctx-123',
          language: 'python',
          cwd: '/workspace',
          createdAt: new Date()
        }
      } as ServiceResult<{
        id: string;
        language: string;
        cwd: string;
        createdAt: Date;
      }>;

      mocked(mockInterpreterService.createContext).mockResolvedValue(
        mockContextResult
      );

      const contextRequest: CreateContextRequest = {
        language: 'python',
        cwd: '/workspace'
      };

      const request = new Request('http://localhost:3000/api/contexts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contextRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify success response: {success: true, contextId, language, cwd, timestamp}
      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ContextCreateResult;
      expect(responseData.success).toBe(true);
      expect(responseData.contextId).toBe('ctx-123');
      expect(responseData.language).toBe('python');
      expect(responseData.cwd).toBe('/workspace');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockInterpreterService.createContext).toHaveBeenCalledWith(
        contextRequest
      );
    });

    it('should handle context creation errors', async () => {
      // Mock context creation failure
      const mockContextError = {
        success: false,
        error: {
          message: 'Invalid language specified',
          code: 'VALIDATION_ERROR',
          details: { language: 'invalid-lang' }
        }
      } as ServiceResult<never>;

      mocked(mockInterpreterService.createContext).mockResolvedValue(
        mockContextError
      );

      const contextRequest: CreateContextRequest = {
        language: 'invalid-lang',
        cwd: '/workspace'
      };

      const request = new Request('http://localhost:3000/api/contexts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contextRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response: {code, message, context, httpStatus, timestamp}
      expect(response.status).toBeGreaterThanOrEqual(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('VALIDATION_ERROR');
      expect(responseData.message).toBe('Invalid language specified');
      expect(responseData.context).toMatchObject({ language: 'invalid-lang' });
      expect(responseData.httpStatus).toBeDefined();
      expect(responseData.timestamp).toBeDefined();
    });

    it('should return 503 with Retry-After for INTERPRETER_NOT_READY', async () => {
      // Mock interpreter not ready error
      const mockNotReadyError = {
        success: false,
        error: {
          message: 'Interpreter is still initializing',
          code: 'INTERPRETER_NOT_READY',
          details: { retryAfter: 10 }
        }
      } as ServiceResult<never>;

      mocked(mockInterpreterService.createContext).mockResolvedValue(
        mockNotReadyError
      );

      const contextRequest: CreateContextRequest = {
        language: 'python',
        cwd: '/workspace'
      };

      const request = new Request('http://localhost:3000/api/contexts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contextRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify 503 status with Retry-After header
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('10');

      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.error.code).toBe('INTERPRETER_NOT_READY');
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - List Contexts', () => {
    it('should list all contexts successfully', async () => {
      // Mock successful context listing
      const mockContexts = {
        success: true,
        data: [
          { id: 'ctx-1', language: 'python', cwd: '/workspace1' },
          { id: 'ctx-2', language: 'javascript', cwd: '/workspace2' }
        ]
      } as ServiceResult<Array<{ id: string; language: string; cwd: string }>>;

      mocked(mockInterpreterService.listContexts).mockResolvedValue(
        mockContexts
      );

      const request = new Request('http://localhost:3000/api/contexts', {
        method: 'GET'
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify success response: {success: true, contexts, timestamp}
      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ContextListResult;
      expect(responseData.success).toBe(true);
      expect(responseData.contexts).toHaveLength(2);
      expect(responseData.contexts[0].id).toBe('ctx-1');
      expect(responseData.contexts[0].language).toBe('python');
      expect(responseData.contexts[0].cwd).toBe('/workspace1');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called
      expect(mockInterpreterService.listContexts).toHaveBeenCalled();
    });

    it('should handle list contexts errors', async () => {
      // Mock listing failure
      const mockListError = {
        success: false,
        error: {
          message: 'Failed to list contexts',
          code: 'UNKNOWN_ERROR',
          details: {}
        }
      } as ServiceResult<never>;

      mocked(mockInterpreterService.listContexts).mockResolvedValue(
        mockListError
      );

      const request = new Request('http://localhost:3000/api/contexts', {
        method: 'GET'
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response: {code, message, context, httpStatus, timestamp}
      expect(response.status).toBeGreaterThanOrEqual(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Failed to list contexts');
      expect(responseData.httpStatus).toBeDefined();
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - Delete Context', () => {
    it('should delete context successfully', async () => {
      // Mock successful deletion
      const mockDeleteResult = {
        success: true,
        data: undefined
      } as ServiceResult<void>;

      mocked(mockInterpreterService.deleteContext).mockResolvedValue(
        mockDeleteResult
      );

      const request = new Request(
        'http://localhost:3000/api/contexts/ctx-123',
        {
          method: 'DELETE'
        }
      );

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify success response: {success: true, contextId, timestamp}
      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ContextDeleteResult;
      expect(responseData.success).toBe(true);
      expect(responseData.contextId).toBe('ctx-123');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called with correct context ID
      expect(mockInterpreterService.deleteContext).toHaveBeenCalledWith(
        'ctx-123'
      );
    });

    it('should handle delete context errors', async () => {
      // Mock deletion failure
      const mockDeleteError = {
        success: false,
        error: {
          message: 'Context not found',
          code: 'RESOURCE_NOT_FOUND',
          details: { contextId: 'ctx-999' }
        }
      } as ServiceResult<never>;

      mocked(mockInterpreterService.deleteContext).mockResolvedValue(
        mockDeleteError
      );

      const request = new Request(
        'http://localhost:3000/api/contexts/ctx-999',
        {
          method: 'DELETE'
        }
      );

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response: {code, message, context, httpStatus, timestamp}
      expect(response.status).toBeGreaterThanOrEqual(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('RESOURCE_NOT_FOUND');
      expect(responseData.message).toBe('Context not found');
      expect(responseData.context).toMatchObject({ contextId: 'ctx-999' });
      expect(responseData.httpStatus).toBeDefined();
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - Execute Code', () => {
    it('should execute code and return streaming response', async () => {
      // Mock streaming response from service
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            'data: {"type":"start","timestamp":"2023-01-01T00:00:00Z"}\n\n'
          );
          controller.enqueue(
            'data: {"type":"stdout","data":"Hello World\\n","timestamp":"2023-01-01T00:00:01Z"}\n\n'
          );
          controller.enqueue(
            'data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:02Z"}\n\n'
          );
          controller.close();
        }
      });

      const mockStreamResponse = new Response(mockStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });

      mocked(mockInterpreterService.executeCode).mockResolvedValue(
        mockStreamResponse
      );

      const executeRequest = {
        context_id: 'ctx-123',
        code: 'print("Hello World")',
        language: 'python'
      };

      const request = new Request('http://localhost:3000/api/execute/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executeRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify streaming response
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.body).toBeDefined();

      // Verify service was called correctly
      expect(mockInterpreterService.executeCode).toHaveBeenCalledWith(
        'ctx-123',
        'print("Hello World")',
        'python'
      );
    });

    it('should handle execute code errors', async () => {
      // Mock error response from service
      const mockErrorResponse = new Response(
        JSON.stringify({
          code: 'RESOURCE_NOT_FOUND',
          message: 'Context not found',
          context: { contextId: 'ctx-invalid' },
          httpStatus: 404,
          timestamp: new Date().toISOString()
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      mocked(mockInterpreterService.executeCode).mockResolvedValue(
        mockErrorResponse
      );

      const executeRequest = {
        context_id: 'ctx-invalid',
        code: 'print("test")',
        language: 'python'
      };

      const request = new Request('http://localhost:3000/api/execute/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executeRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response: {code, message, context, httpStatus, timestamp}
      expect(response.status).toBe(404);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('RESOURCE_NOT_FOUND');
      expect(responseData.message).toBe('Context not found');
      expect(responseData.context).toMatchObject({ contextId: 'ctx-invalid' });
      expect(responseData.httpStatus).toBe(404);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - Execute Async Code', () => {
    it('should execute code that returns a resolved Promise and stream the result', async () => {
      // Simulate a streaming response for resolved Promise
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            'data: {"type":"start","timestamp":"2023-01-01T00:00:00Z"}\n\n'
          );
          controller.enqueue(
            'data: {"type":"stdout","data":"42\\n","timestamp":"2023-01-01T00:00:01Z"}\n\n'
          );
          controller.enqueue(
            'data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:02Z"}\n\n'
          );
          controller.close();
        }
      });
      const mockStreamResponse = new Response(mockStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });
      mocked(mockInterpreterService.executeCode).mockResolvedValue(
        mockStreamResponse
      );

      const executeRequest = {
        context_id: 'ctx-123',
        code: 'Promise.resolve(42)',
        language: 'javascript'
      };

      const request = new Request('http://localhost:3000/api/execute/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executeRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.body).toBeDefined();
      expect(mockInterpreterService.executeCode).toHaveBeenCalledWith(
        'ctx-123',
        'Promise.resolve(42)',
        'javascript'
      );
    });

    it('should execute code that returns from an async function and stream the result', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            'data: {"type":"start","timestamp":"2023-01-01T00:00:00Z"}\n\n'
          );
          controller.enqueue(
            'data: {"type":"stdout","data":"async result\\n","timestamp":"2023-01-01T00:00:01Z"}\n\n'
          );
          controller.enqueue(
            'data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:02Z"}\n\n'
          );
          controller.close();
        }
      });
      const mockStreamResponse = new Response(mockStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      });
      mocked(mockInterpreterService.executeCode).mockResolvedValue(
        mockStreamResponse
      );

      const executeRequest = {
        context_id: 'ctx-123',
        code: '(async () => { return "async result" })()',
        language: 'javascript'
      };

      const request = new Request('http://localhost:3000/api/execute/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executeRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.body).toBeDefined();
      expect(mockInterpreterService.executeCode).toHaveBeenCalledWith(
        'ctx-123',
        '(async () => { return "async result" })()',
        'javascript'
      );
    });

    it('should handle code that returns a rejected Promise', async () => {
      const mockErrorResponse = new Response(
        JSON.stringify({
          code: ErrorCode.CODE_EXECUTION_ERROR,
          message: 'Promise rejected',
          context: { contextId: 'ctx-123' },
          httpStatus: 500,
          timestamp: new Date().toISOString()
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
      mocked(mockInterpreterService.executeCode).mockResolvedValue(
        mockErrorResponse
      );

      const executeRequest = {
        context_id: 'ctx-123',
        code: 'Promise.reject(new Error("Promise rejected"))',
        language: 'javascript'
      };

      const request = new Request('http://localhost:3000/api/execute/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executeRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe(ErrorCode.CODE_EXECUTION_ERROR);
      expect(responseData.message).toBe('Promise rejected');
      expect(responseData.context).toMatchObject({ contextId: 'ctx-123' });
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle code that throws an error in async context', async () => {
      const mockErrorResponse = new Response(
        JSON.stringify({
          code: ErrorCode.CODE_EXECUTION_ERROR,
          message: 'Thrown error',
          context: { contextId: 'ctx-123' },
          httpStatus: 500,
          timestamp: new Date().toISOString()
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
      mocked(mockInterpreterService.executeCode).mockResolvedValue(
        mockErrorResponse
      );

      const executeRequest = {
        context_id: 'ctx-123',
        code: '(async () => { throw new Error("Thrown error") })()',
        language: 'javascript'
      };

      const request = new Request('http://localhost:3000/api/execute/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executeRequest)
      });

      const response = await interpreterHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe(ErrorCode.CODE_EXECUTION_ERROR);
      expect(responseData.message).toBe('Thrown error');
      expect(responseData.context).toMatchObject({ contextId: 'ctx-123' });
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - Invalid Endpoints', () => {
    it('should return error for invalid interpreter endpoint', async () => {
      const request = new Request(
        'http://localhost:3000/api/interpreter/invalid',
        {
          method: 'GET'
        }
      );

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response: {code, message, context, httpStatus, timestamp}
      expect(response.status).toBeGreaterThanOrEqual(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid interpreter endpoint');
      expect(responseData.httpStatus).toBeDefined();
      expect(responseData.timestamp).toBeDefined();
    });

    it('should return error for invalid HTTP method', async () => {
      const request = new Request('http://localhost:3000/api/contexts', {
        method: 'PUT' // Invalid method
      });

      const response = await interpreterHandler.handle(request, mockContext);

      // Verify error response for invalid endpoint/method combination
      expect(response.status).toBeGreaterThanOrEqual(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid interpreter endpoint');
    });
  });
});
