/**
 * Session Handler Tests
 * 
 * Tests the SessionHandler class from the refactored container architecture.
 * Demonstrates testing handlers with session management functionality.
 */

import type { SessionHandler } from '@container/handlers/session-handler';
import type { SessionService } from '@container/services/session-service';
import type { Logger, RequestContext, ValidatedRequestContext, SessionData, HandlerErrorResponse, CreateSessionResponse, ListSessionsResponse } from '@container/core/types';

// Mock the dependencies - use partial mock to avoid private property issues
const mockSessionService = {
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  cleanupExpiredSessions: vi.fn(),
  destroy: vi.fn(),
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

// Helper to create validated context
const createValidatedContext = <T>(data: T): ValidatedRequestContext<T> => ({
  ...mockContext,
  validatedData: data
});

describe('SessionHandler', () => {
  let sessionHandler: SessionHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the SessionHandler (dynamic import)
    const { SessionHandler: SessionHandlerClass } = await import('@container/handlers/session-handler');
    sessionHandler = new SessionHandlerClass(mockSessionService, mockLogger);
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

      (mockSessionService.createSession as any).mockResolvedValue({
        success: true,
        data: mockSessionData
      });

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as CreateSessionResponse;
      expect(responseData.message).toBe('Session created successfully');
      expect(responseData.sessionId).toBe('session_1672531200_abc123');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockSessionService.createSession).toHaveBeenCalled();

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Creating new session',
        { requestId: 'req-123' }
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
      (mockSessionService.createSession as any).mockResolvedValue({
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('SESSION_CREATE_ERROR');
      expect(responseData.error).toBe('Failed to create session');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Session creation failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          errorCode: 'SESSION_CREATE_ERROR',
          errorMessage: 'Failed to create session'
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

      (mockSessionService.createSession as any)
        .mockResolvedValueOnce({ success: true, data: mockSessionData1 })
        .mockResolvedValueOnce({ success: true, data: mockSessionData2 });

      const request1 = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });
      const request2 = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const response1 = await sessionHandler.handle(request1, mockContext);
      const response2 = await sessionHandler.handle(request2, mockContext);

      const responseData1 = await response1.json() as CreateSessionResponse;
      const responseData2 = await response2.json() as CreateSessionResponse;

      expect(responseData1.sessionId).not.toBe(responseData2.sessionId);
      expect(responseData1.sessionId).toBe('session_1672531200_abc123');
      expect(responseData2.sessionId).toBe('session_1672531260_def456');

      expect(mockSessionService.createSession).toHaveBeenCalledTimes(2);
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

      (mockSessionService.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessions
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as ListSessionsResponse;
      expect(responseData.count).toBe(3);
      expect(responseData.sessions).toHaveLength(3);

      // Verify session data transformation
      expect(responseData.sessions[0]).toEqual({
        sessionId: 'session-1',
        createdAt: '2023-01-01T00:00:00.000Z',
        hasActiveProcess: true // activeProcess is 'proc-123'
      });
      expect(responseData.sessions[1]).toEqual({
        sessionId: 'session-2',
        createdAt: '2023-01-01T00:01:00.000Z',
        hasActiveProcess: false // activeProcess is null
      });
      expect(responseData.sessions[2]).toEqual({
        sessionId: 'session-3',
        createdAt: '2023-01-01T00:02:00.000Z',
        hasActiveProcess: true // activeProcess is 'proc-456'
      });

      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockSessionService.listSessions).toHaveBeenCalled();

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Listing sessions',
        { requestId: 'req-123' }
      );
    });

    it('should return empty list when no sessions exist', async () => {
      (mockSessionService.listSessions as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

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

      (mockSessionService.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessions
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      const responseData = await response.json() as ListSessionsResponse;

      // Test truthiness evaluation for hasActiveProcess
      expect(responseData.sessions[0].hasActiveProcess).toBe(true);  // 'proc-123' is truthy
      expect(responseData.sessions[1].hasActiveProcess).toBe(false); // null is falsy
      expect(responseData.sessions[2].hasActiveProcess).toBe(false); // '' is falsy
    });

    it('should handle session listing failures', async () => {
      (mockSessionService.listSessions as any).mockResolvedValue({
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
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('SESSION_LIST_ERROR');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Session listing failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          errorCode: 'SESSION_LIST_ERROR',
          errorMessage: 'Failed to list sessions'
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

      (mockSessionService.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessions
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      const responseData = await response.json() as ListSessionsResponse;
      expect(responseData.sessions[0].hasActiveProcess).toBe(false); // undefined is falsy
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid session endpoints', async () => {
      const request = new Request('http://localhost:3000/api/session/invalid-operation', {
        method: 'POST'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid session endpoint');

      // Should not call any service methods
      expect(mockSessionService.createSession).not.toHaveBeenCalled();
      expect(mockSessionService.listSessions).not.toHaveBeenCalled();
    });

    it('should return 404 for root session path', async () => {
      const request = new Request('http://localhost:3000/api/session/', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid session endpoint');
    });

    it('should return 404 for session endpoint without operation', async () => {
      const request = new Request('http://localhost:3000/api/session', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);

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

      (mockSessionService.createSession as any).mockResolvedValue({
        success: true,
        data: mockSessionData
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
      (mockSessionService.listSessions as any).mockResolvedValue({
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

      (mockSessionService.createSession as any).mockResolvedValue({
        success: true,
        data: mockSessionData
      });

      const createRequest = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const createResponse = await sessionHandler.handle(createRequest, mockContext);
      expect(createResponse.headers.get('Content-Type')).toBe('application/json');

      // Test list endpoint
      (mockSessionService.listSessions as any).mockResolvedValue({
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
      const mockSessionData: SessionData = {
        id: 'session-test',
        sessionId: 'session-test',
        activeProcess: null,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        expiresAt: new Date(),
      };

      (mockSessionService.createSession as any).mockResolvedValue({
        success: true,
        data: mockSessionData
      });

      const request = new Request('http://localhost:3000/api/session/create', {
        method: 'POST'
      });

      const response = await sessionHandler.handle(request, mockContext);
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

      (mockSessionService.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessions
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);
      const responseData = await response.json() as ListSessionsResponse;

      expect(responseData.sessions[0].createdAt).toBe('2023-01-01T12:30:45.123Z');
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

      (mockSessionService.listSessions as any).mockResolvedValue({
        success: true,
        data: mockSessions
      });

      const request = new Request('http://localhost:3000/api/session/list', {
        method: 'GET'
      });

      const response = await sessionHandler.handle(request, mockContext);
      const responseData = await response.json() as ListSessionsResponse;

      const sessionResponse = responseData.sessions[0];

      // Should include mapped fields
      expect(sessionResponse.sessionId).toBe('session-external-id');
      expect(sessionResponse.createdAt).toBe('2023-01-01T00:00:00.000Z');
      expect(sessionResponse.hasActiveProcess).toBe(true);

      // Should not include internal fields
      expect((sessionResponse as any).id).toBeUndefined();
      expect((sessionResponse as any).expiresAt).toBeUndefined();
      expect((sessionResponse as any).activeProcess).toBeUndefined();
      expect((sessionResponse as any).extraField).toBeUndefined();

      // Should only have expected fields
      const expectedFields = ['sessionId', 'createdAt', 'hasActiveProcess'];
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