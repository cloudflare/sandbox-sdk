import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  ContextCreateResult,
  ContextDeleteResult,
  ContextListResult,
  InterpreterHealthResult,
  Logger
} from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type {
  RequestContext,
  ServiceResult
} from '@sandbox-container/core/types';
import { InterpreterHandler } from '@sandbox-container/handlers/interpreter-handler.js';
import type {
  Context,
  CreateContextRequest,
  HealthStatus
} from '@sandbox-container/interpreter-service';
import type { InterpreterService } from '@sandbox-container/services/interpreter-service';
import { mocked } from '../test-utils';

// Mock the service dependencies
const mockInterpreterService = {
  getHealthStatus: vi.fn(),
  createContext: vi.fn(),
  listContexts: vi.fn(),
  deleteContext: vi.fn(),
  executeCode: vi.fn()
} as unknown as InterpreterService;

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
          ready: true,
          initializing: false,
          progress: 1.0
        }
      } as ServiceResult<HealthStatus>;

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
          createdAt: '2023-01-01T00:00:00Z',
          lastUsed: '2023-01-01T00:00:00Z'
        }
      } as ServiceResult<Context>;

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
          code: ErrorCode.VALIDATION_FAILED,
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
      expect(responseData.code).toBe(ErrorCode.VALIDATION_FAILED);
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

      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('INTERPRETER_NOT_READY');
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handle - List Contexts', () => {
    it('should list all contexts successfully', async () => {
      // Mock successful context listing
      const mockContexts = {
        success: true,
        data: [
          {
            id: 'ctx-1',
            language: 'python',
            cwd: '/workspace1',
            createdAt: '2023-01-01T00:00:00Z',
            lastUsed: '2023-01-01T00:00:00Z'
          },
          {
            id: 'ctx-2',
            language: 'javascript',
            cwd: '/workspace2',
            createdAt: '2023-01-01T00:00:00Z',
            lastUsed: '2023-01-01T00:00:00Z'
          }
        ]
      } as ServiceResult<Context[]>;

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
          code: ErrorCode.CONTEXT_NOT_FOUND,
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
      expect(responseData.code).toBe(ErrorCode.CONTEXT_NOT_FOUND);
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
          code: ErrorCode.CONTEXT_NOT_FOUND,
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
      expect(responseData.code).toBe(ErrorCode.CONTEXT_NOT_FOUND);
      expect(responseData.message).toBe('Context not found');
      expect(responseData.context).toMatchObject({ contextId: 'ctx-invalid' });
      expect(responseData.httpStatus).toBe(404);
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
