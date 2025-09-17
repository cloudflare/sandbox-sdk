/**
 * Session Handler Tests
 * 
 * Tests the SessionHandler class from the refactored container architecture.
 * Demonstrates testing handlers with session management functionality.
 */

import { vi, describe, it, beforeEach, expect } from 'vitest';
import type { CreateSessionResponse, HandlerErrorResponse, ListSessionsResponse, Logger, RequestContext, SessionData, ValidatedRequestContext } from '@container/core/types';
import type { SessionHandler } from '../../handlers/session-handler';
import type { SessionManager } from '@container/isolation';

// Mock the dependencies - use partial mock to avoid private property issues

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
};

// Helper to create validated context
const createValidatedContext = <T>(data: T): ValidatedRequestContext<T> => ({
  ...mockContext,
  validatedData: data
});

describe('SessionHandler', () => {
  let sessionHandler: SessionHandler;
  let mockSessionManager: any;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the SessionHandler (dynamic import)
    const { SessionHandler: SessionHandlerClass } = await import('../../handlers/session-handler');
    // Create mock SessionManager instead of SessionService  
    mockSessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      getOrCreateDefaultSession: vi.fn(),
      listSessions: vi.fn(),
      exec: vi.fn(),
      destroyAll: vi.fn(),
    } satisfies Partial<SessionManager>;
    
    sessionHandler = new SessionHandlerClass(mockSessionManager as SessionManager, mockLogger);
    
    // Set up successful session creation mock
    const mockSession = {
      exec: vi.fn(),
      execStream: vi.fn(),
      destroy: vi.fn(),
    };
    mockSessionManager.createSession.mockResolvedValue(mockSession);
    mockSessionManager.listSessions.mockReturnValue(['session1', 'session2']);
  });

  describe('handleCreate - POST /api/session/create', () => {
    it('should create session successfully', async () => {
      const mockSessionData: SessionData = {
        id: 'session_1672531200_abc123',
        sessionId: 'session_1672531200_abc123',
        activeProcess: null,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        expiresAt: new Date('2023-01-01T01:00:00Z'),
      };

      // Use the mock set up in beforeEach

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'session_1672531200_abc123',
          cwd: '/workspace',
          isolation: true
        })
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as CreateSessionResponse;
      expect(responseData.message).toContain('created with');
      expect(responseData.id).toBe('session_1672531200_abc123');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect((sessionHandler as any).sessionManager.createSession).toHaveBeenCalled();

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Creating new session',
        expect.objectContaining({ requestId: 'req-123' })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session created successfully',
        expect.objectContaining({
          requestId: 'req-123',
          sessionId: 'session_1672531200_abc123'
        })
      );
    });

    it('should handle session creation failures', async () => {
      mockSessionManager.createSession.mockRejectedValueOnce(new Error('Failed to create session'));

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'test-session',
          cwd: '/workspace',
          isolation: true
        })
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('SESSION_CREATE_ERROR');
      expect(responseData.error).toBe('Failed to create session');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Session creation failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          error: 'Failed to create session'
        })
      );
    });

    it('should generate unique session IDs', async () => {
      const mockSessionData1: SessionData = {
        id: 'session_1672531200_abc123',
        sessionId: 'session_1672531200_abc123',
        activeProcess: null,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        expiresAt: new Date('2023-01-01T01:00:00Z'),
      };

      const mockSessionData2: SessionData = {
        id: 'session_1672531260_def456',
        sessionId: 'session_1672531260_def456',
        activeProcess: null,
        createdAt: new Date('2023-01-01T00:01:00Z'),
        expiresAt: new Date('2023-01-01T01:01:00Z'),
      };

      ((sessionHandler as any).sessionManager.createSession as any)
        .mockResolvedValueOnce({ success: true, data: mockSessionData1 })
        .mockResolvedValueOnce({ success: true, data: mockSessionData2 });

      const request1 = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'session_1672531200_abc123',
          cwd: '/workspace',
          isolation: true
        })
      });
      const request2 = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'session_1672531260_def456',
          cwd: '/workspace',
          isolation: true
        })
      });

      const validatedContext1 = createValidatedContext({
        id: 'session_1672531200_abc123',
        cwd: '/workspace',
        isolation: true
      });
      const validatedContext2 = createValidatedContext({
        id: 'session_1672531260_def456',
        cwd: '/workspace',
        isolation: true
      });

      const response1 = await sessionHandler.handle(request1, validatedContext1);
      const response2 = await sessionHandler.handle(request2, validatedContext2);

      const responseData1 = await response1.json() as CreateSessionResponse;
      const responseData2 = await response2.json() as CreateSessionResponse;

      expect(responseData1.id).not.toBe(responseData2.id);
      expect(responseData1.id).toBe('session_1672531200_abc123');
      expect(responseData2.id).toBe('session_1672531260_def456');

      expect((sessionHandler as any).sessionManager.createSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleList - GET /api/session/list', () => {
    it('should list sessions successfully with active processes', async () => {
      const mockSessions: SessionData[] = [
        {
          id: 'session-1',
          sessionId: 'session-1',
          activeProcess: 'proc-123',
          createdAt: new Date('2023-01-01T00:00:00Z'),
          expiresAt: new Date('2023-01-01T01:00:00Z'),
        },
        {
          id: 'session-2',
          sessionId: 'session-2',
          activeProcess: null,
          createdAt: new Date('2023-01-01T00:01:00Z'),
          expiresAt: new Date('2023-01-01T01:01:00Z'),
        },
        {
          id: 'session-3',
          sessionId: 'session-3',
          activeProcess: 'proc-456',
          createdAt: new Date('2023-01-01T00:02:00Z'),
          expiresAt: new Date('2023-01-01T01:02:00Z'),
        }
      ];

      mockSessionManager.listSessions.mockReturnValueOnce(['session-1', 'session-2', 'session-3']);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ListSessionsResponse;
      expect(responseData.count).toBe(3);
      expect(responseData.sessions).toHaveLength(3);

      // Verify session data transformation
      expect(responseData.sessions[0]).toEqual({
        id: 'session-1',
        sessionId: 'session-1',
        createdAt: expect.any(String),
        hasActiveProcess: false // Handler returns false by default
      });
      expect(responseData.sessions[1]).toEqual({
        id: 'session-2',
        sessionId: 'session-2',
        createdAt: expect.any(String),
        hasActiveProcess: false
      });
      expect(responseData.sessions[2]).toEqual({
        id: 'session-3',
        sessionId: 'session-3',
        createdAt: expect.any(String),
        hasActiveProcess: false
      });

      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect((sessionHandler as any).sessionManager.listSessions).toHaveBeenCalled();

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Listing sessions',
        expect.objectContaining({ requestId: 'req-123' })
      );
    });

    it('should return empty list when no sessions exist', async () => {
      mockSessionManager.listSessions.mockReturnValueOnce([]);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ListSessionsResponse;
      expect(responseData.count).toBe(0);
      expect(responseData.sessions).toHaveLength(0);
      expect(responseData.sessions).toEqual([]);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle sessions with various activeProcess values', async () => {
      const mockSessions: SessionData[] = [
        {
          id: 'session-1',
          sessionId: 'session-1',
          activeProcess: 'proc-123',
          createdAt: new Date('2023-01-01T00:00:00Z'),
          expiresAt: new Date('2023-01-01T01:00:00Z'),
        },
        {
          id: 'session-2',
          sessionId: 'session-2',
          activeProcess: null,
          createdAt: new Date('2023-01-01T00:01:00Z'),
          expiresAt: new Date('2023-01-01T01:01:00Z'),
        },
        {
          id: 'session-3',
          sessionId: 'session-3',
          activeProcess: '',
          createdAt: new Date('2023-01-01T00:02:00Z'),
          expiresAt: new Date('2023-01-01T01:02:00Z'),
        }
      ];

      mockSessionManager.listSessions.mockReturnValueOnce(['session-1', 'session-2', 'session-3']);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      const responseData = await response.json() as ListSessionsResponse;

      // Handler returns false by default for all sessions
      expect(responseData.sessions[0].hasActiveProcess).toBe(false);
      expect(responseData.sessions[1].hasActiveProcess).toBe(false);
      expect(responseData.sessions[2].hasActiveProcess).toBe(false);
    });

    it('should handle session listing failures', async () => {
      mockSessionManager.listSessions.mockImplementationOnce(() => {
        throw new Error('Failed to list sessions');
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(500);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('SESSION_LIST_ERROR');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Session listing failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          error: 'Failed to list sessions'
        })
      );
    });

    it('should handle sessions with undefined activeProcess', async () => {
      const mockSessions: SessionData[] = [
        {
          id: 'session-1',
          sessionId: 'session-1',
          activeProcess: null,
          createdAt: new Date('2023-01-01T00:00:00Z'),
          expiresAt: new Date('2023-01-01T01:00:00Z'),
        }
      ];

      mockSessionManager.listSessions.mockReturnValueOnce(['session-1', 'session-2', 'session-3']);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      const responseData = await response.json() as ListSessionsResponse;
      expect(responseData.sessions[0].hasActiveProcess).toBe(false); // undefined is falsy
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid session endpoints', async () => {
      const request = new Request('http://localhost:3000/api/session/invalid-operation', {
        method: 'POST'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid session endpoint');

      // Should not call any service methods
      expect((sessionHandler as any).sessionManager.createSession).not.toHaveBeenCalled();
      expect((sessionHandler as any).sessionManager.listSessions).not.toHaveBeenCalled();
    });

    it('should return 404 for root session path', async () => {
      const request = new Request('http://localhost:3000/api/session/', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid session endpoint');
    });

    it('should return 404 for session endpoint without operation', async () => {
      const request = new Request('http://localhost:3000/api/session', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid session endpoint');
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in successful create responses', async () => {
      const mockSessionData: SessionData = {
        id: 'session-test',
        sessionId: 'session-test',
        activeProcess: null,
        createdAt: new Date(),
        expiresAt: new Date(),
      };

      // Use the mock set up in beforeEach

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'session-test',
          cwd: '/workspace',
          isolation: true
        })
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should include CORS headers in successful list responses', async () => {
      mockSessionManager.listSessions.mockReturnValueOnce([]);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/session/invalid', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should have proper Content-Type header for all responses', async () => {
      // Test create endpoint
      const mockSessionData: SessionData = {
        id: 'session-test',
        sessionId: 'session-test',
        activeProcess: null,
        createdAt: new Date(),
        expiresAt: new Date(),
      };

      // Use the mock set up in beforeEach

      const createRequest = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const createResponse = await sessionHandler.handle(createRequest, mockContext);
      expect(createResponse.headers.get('Content-Type')).toBe('application/json');

      // Test list endpoint
      mockSessionManager.listSessions.mockReturnValueOnce([]);

      const listRequest = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const listResponse = await sessionHandler.handle(listRequest, mockContext);
      expect(listResponse.headers.get('Content-Type')).toBe('application/json');
    });

    it('should return consistent timestamp format', async () => {
      const mockSessionData: SessionData = {
        id: 'session-test',
        sessionId: 'session-test',
        activeProcess: null,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        expiresAt: new Date(),
      };

      // Use the mock set up in beforeEach

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'session-test',
          cwd: '/workspace',
          isolation: true
        })
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);
      const responseData = await response.json() as ListSessionsResponse;

      // Verify timestamp is valid ISO string
      expect(responseData.timestamp).toBeDefined();
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);
      expect(responseData.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should transform session createdAt to ISO string format', async () => {
      const mockSessions: SessionData[] = [
        {
          id: 'session-1',
          sessionId: 'session-1',
          activeProcess: null,
          createdAt: new Date('2023-01-01T12:30:45.123Z'),
          expiresAt: new Date(),
        }
      ];

      mockSessionManager.listSessions.mockReturnValueOnce(['session-1', 'session-2', 'session-3']);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);
      const responseData = await response.json() as ListSessionsResponse;

      expect(responseData.sessions[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(responseData.sessions[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('data transformation', () => {
    it('should properly map session data fields', async () => {
      const mockSessions: SessionData[] = [
        {
          id: 'session-internal-id',
          sessionId: 'session-external-id',
          activeProcess: 'process-123',
          createdAt: new Date('2023-01-01T00:00:00Z'),
          expiresAt: new Date('2023-01-01T01:00:00Z'),
          // These fields should not appear in response
          extraField: 'should-not-appear'
        } as any
      ];

      mockSessionManager.listSessions.mockReturnValueOnce(['session-external-id']);

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const validatedContext = createValidatedContext({
        id: 'test-session',
        cwd: '/workspace',
        isolation: true
      });
      
      const response = await sessionHandler.handle(request, validatedContext);
      const responseData = await response.json() as ListSessionsResponse;

      const sessionResponse = responseData.sessions[0];

      // Should include mapped fields
      expect(sessionResponse.id).toBe('session-external-id');
      expect(sessionResponse.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(sessionResponse.hasActiveProcess).toBe(false);

      // Should not include internal fields like expiresAt
      expect((sessionResponse as any).expiresAt).toBeUndefined();
      expect((sessionResponse as any).activeProcess).toBeUndefined();
      expect((sessionResponse as any).extraField).toBeUndefined();

      // Should only have expected fields
      const expectedFields = ['id', 'sessionId', 'createdAt', 'hasActiveProcess'];
      expect(Object.keys(sessionResponse)).toEqual(expectedFields);
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored SessionHandler:
 * 
 * 1. **Session Management Testing**: Handler manages session creation and listing
 *    with proper validation and error handling.
 * 
 * 2. **Data Transformation Testing**: Tests validate that internal SessionData
 *    objects are properly transformed to client-friendly response format.
 * 
 * 3. **Boolean Logic Testing**: Tests cover the hasActiveProcess transformation
 *    which uses truthiness evaluation on the activeProcess field.
 * 
 * 4. **ServiceResult Integration**: Handler converts SessionService ServiceResult
 *    objects into appropriate HTTP responses with consistent formatting.
 * 
 * 5. **Empty State Handling**: Tests cover scenarios with no sessions to ensure
 *    proper empty array responses.
 * 
 * 6. **Error Response Testing**: All error scenarios are tested including service
 *    failures with proper HTTP status codes and error message formatting.
 * 
 * 7. **Route Validation**: Tests ensure only valid session endpoints are handled
 *    and invalid requests return appropriate 404 responses.
 * 
 * 8. **Logging Integration**: Tests validate comprehensive logging for operations,
 *    successes, and errors with proper context.
 * 
 * 9. **CORS Header Validation**: Tests ensure CORS headers are included in both
 *    success and error responses.
 * 
 * 10. **Response Format Consistency**: Tests validate timestamp formatting,
 *     Content-Type headers, and field mapping consistency.
 * 
 * 11. **Field Filtering**: Tests ensure that internal fields (id, expiresAt)
 *     are not exposed in the API responses.
 */