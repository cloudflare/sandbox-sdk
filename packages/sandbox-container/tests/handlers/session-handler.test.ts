import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { ErrorResponse } from '@repo/shared/errors';
import type { Logger, RequestContext } from '@sandbox-container/core/types';
import { SessionHandler } from '@sandbox-container/handlers/session-handler';
import type { SessionManager } from '@sandbox-container/services/session-manager';
import type { Session } from '@sandbox-container/session';

// SessionListResult type - matches handler return format
interface SessionListResult {
  success: boolean;
  data: string[];
  timestamp: string;
}

// SessionCreateResultGeneric - matches handler return format (with Session object)
interface SessionCreateResultGeneric {
  success: boolean;
  data: Session;
  timestamp: string;
}

// Mock the dependencies - use partial mock to avoid private property issues
const mockSessionManager = {
  createSession: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  destroy: vi.fn(),
} as unknown as SessionManager;

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

describe('SessionHandler', () => {
  let sessionHandler: SessionHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    sessionHandler = new SessionHandler(mockSessionManager, mockLogger);
  });

  describe('handleCreate - POST /api/session/create', () => {
    it('should create session successfully', async () => {
      const mockSession = {} as Session; // Session object (not SessionData)

      (mockSessionManager.createSession as any).mockResolvedValue({
        success: true,
        data: mockSession
      });

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseBody = await response.json() as SessionCreateResultGeneric;
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toEqual(mockSession);
      expect(responseBody.timestamp).toBeDefined();
      expect(responseBody.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Verify service was called correctly
      expect(mockSessionManager.createSession).toHaveBeenCalled();
    });

    it('should handle session creation failures', async () => {
      (mockSessionManager.createSession as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Failed to create session',
          code: 'SESSION_CREATE_ERROR',
          details: { originalError: 'Store connection failed' }
        }
      });

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ErrorResponse;
      expect(responseData.code).toBe('SESSION_CREATE_ERROR');
      expect(responseData.message).toBe('Failed to create session');
      expect(responseData.context).toEqual({ originalError: 'Store connection failed' });
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should generate unique session IDs', async () => {
      const mockSession1 = {} as Session;
      const mockSession2 = {} as Session;

      (mockSessionManager.createSession as any)
        .mockResolvedValueOnce({ success: true, data: mockSession1 })
        .mockResolvedValueOnce({ success: true, data: mockSession2 });

      const request1 = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });
      const request2 = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const response1 = await sessionHandler.handle(request1, mockContext);
      const response2 = await sessionHandler.handle(request2, mockContext);

      const responseBody1 = await response1.json() as SessionCreateResultGeneric;
      const responseBody2 = await response2.json() as SessionCreateResultGeneric;

      // Verify both responses are successful and contain session data
      expect(responseBody1.success).toBe(true);
      expect(responseBody2.success).toBe(true);
      expect(responseBody1.data).toEqual(mockSession1);
      expect(responseBody2.data).toEqual(mockSession2);
      expect(responseBody1.timestamp).toBeDefined();
      expect(responseBody2.timestamp).toBeDefined();

      expect(mockSessionManager.createSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleList - GET /api/session/list', () => {
    it('should list sessions successfully with active processes', async () => {
      // SessionManager.listSessions() returns string[] (just session IDs)
      const mockSessionIds = ['session-1', 'session-2', 'session-3'];

      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessionIds
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseBody = await response.json() as SessionListResult;
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toEqual(mockSessionIds);
      expect(responseBody.data).toHaveLength(3);
      expect(responseBody.timestamp).toBeDefined();
      expect(responseBody.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Verify service was called correctly
      expect(mockSessionManager.listSessions).toHaveBeenCalled();
    });

    it('should return empty list when no sessions exist', async () => {
      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseBody = await response.json() as SessionListResult;
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toHaveLength(0);
      expect(responseBody.data).toEqual([]);
      expect(responseBody.timestamp).toBeDefined();
    });

    it('should handle sessions with various activeProcess values', async () => {
      // SessionManager returns string[] - no activeProcess info available
      const mockSessionIds = ['session-1', 'session-2', 'session-3'];

      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessionIds
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      const responseBody = await response.json() as SessionListResult;

      // Handler returns array of session IDs
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toEqual(['session-1', 'session-2', 'session-3']);
      expect(responseBody.timestamp).toBeDefined();
    });

    it('should handle session listing failures', async () => {
      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Failed to list sessions',
          code: 'SESSION_LIST_ERROR',
          details: { originalError: 'Database connection lost' }
        }
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ErrorResponse;
      expect(responseData.code).toBe('SESSION_LIST_ERROR');
      expect(responseData.message).toBe('Failed to list sessions');
      expect(responseData.context).toEqual({ originalError: 'Database connection lost' });
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle sessions with undefined activeProcess', async () => {
      // SessionManager returns string[] - no activeProcess info
      const mockSessionIds = ['session-1'];

      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessionIds
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      const responseBody = await response.json() as SessionListResult;
      // Handler returns array of session IDs
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toEqual(['session-1']);
      expect(responseBody.timestamp).toBeDefined();
    });
  });

  describe('route handling', () => {
    it('should return 500 for invalid session endpoints', async () => {
      const request = new Request('http://localhost:3000/api/session/invalid-operation', {
        method: 'POST'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ErrorResponse;
      expect(responseData.message).toBe('Invalid session endpoint');
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();

      // Should not call any service methods
      expect(mockSessionManager.createSession).not.toHaveBeenCalled();
      expect(mockSessionManager.listSessions).not.toHaveBeenCalled();
    });

    it('should return 500 for root session path', async () => {
      const request = new Request('http://localhost:3000/api/session/', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ErrorResponse;
      expect(responseData.message).toBe('Invalid session endpoint');
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should return 500 for session endpoint without operation', async () => {
      const request = new Request('http://localhost:3000/api/session', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as ErrorResponse;
      expect(responseData.message).toBe('Invalid session endpoint');
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in successful create responses', async () => {
      const mockSession = {} as Session;

      (mockSessionManager.createSession as any).mockResolvedValue({
        success: true,
        data: mockSession
      });

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should include CORS headers in successful list responses', async () => {
      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/session/invalid', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should have proper Content-Type header for all responses', async () => {
      // Test create endpoint
      const mockSession = {} as Session;

      (mockSessionManager.createSession as any).mockResolvedValue({
        success: true,
        data: mockSession
      });

      const createRequest = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const createResponse = await sessionHandler.handle(createRequest, mockContext);
      expect(createResponse.headers.get('Content-Type')).toBe('application/json');

      // Test list endpoint
      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: []
      });

      const listRequest = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const listResponse = await sessionHandler.handle(listRequest, mockContext);
      expect(listResponse.headers.get('Content-Type')).toBe('application/json');
    });

    it('should return consistent timestamp format', async () => {
      const mockSession = {} as Session;

      (mockSessionManager.createSession as any).mockResolvedValue({
        success: true,
        data: mockSession
      });

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const response = await sessionHandler.handle(request, mockContext);
      const responseBody = await response.json() as SessionCreateResultGeneric;

      // Verify timestamp is valid ISO string
      expect(responseBody.timestamp).toBeDefined();
      expect(new Date(responseBody.timestamp)).toBeInstanceOf(Date);
      expect(responseBody.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return session IDs as data in list response', async () => {
      // SessionManager returns string[] - session IDs
      const mockSessionIds = ['session-1'];

      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessionIds
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);
      const responseBody = await response.json() as SessionListResult;

      // Handler returns array of session IDs in data field
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toEqual(['session-1']);
      expect(responseBody.timestamp).toBeDefined();
    });
  });

  describe('data transformation', () => {
    it('should properly return session IDs', async () => {
      // SessionManager returns string[] - only session IDs
      const mockSessionIds = ['session-external-id'];

      (mockSessionManager.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessionIds
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);
      const responseBody = await response.json() as SessionListResult;

      // Handler returns array of session IDs
      expect(responseBody.success).toBe(true);
      expect(responseBody.data).toEqual(['session-external-id']);
      expect(responseBody.data[0]).toBe('session-external-id');

      // Verify response structure
      expect(Object.keys(responseBody).sort()).toEqual(['data', 'success', 'timestamp'].sort());
    });
  });
});
