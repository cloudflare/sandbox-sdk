/**
 * Misc Handler Tests
 * 
 * Tests the MiscHandler class from the refactored container architecture.
 * Demonstrates testing handlers with utility endpoints and different response types.
 */

import type { CommandsResponse, HandlerErrorResponse, Logger, PingResponse, RequestContext, ValidatedRequestContext } from '@container/core/types';
import type { MiscHandler } from '@container/handlers/misc-handler';

// Mock the dependencies
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

describe('MiscHandler', () => {
  let miscHandler: MiscHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the MiscHandler (dynamic import)
    const { MiscHandler: MiscHandlerClass } = await import('@container/handlers/misc-handler');
    miscHandler = new MiscHandlerClass(mockLogger);
  });

  describe('handleRoot - GET /', () => {
    it('should return welcome message with text/plain content type', async () => {
      const request = new Request('http://localhost:3000/', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Hello from Bun server! 🚀');
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');

      // Should not log for root endpoint (no logging in implementation)
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('should include CORS headers in root response', async () => {
      const request = new Request('http://localhost:3000/', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should handle different HTTP methods on root', async () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE'];
      
      for (const method of methods) {
        const request = new Request('http://localhost:3000/', {
          method
        });

        const response = await miscHandler.handle(request, mockContext);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('Hello from Bun server! 🚀');
      }
    });
  });

  describe('handlePing - GET /api/ping', () => {
    it('should return pong response with JSON content type', async () => {
      const request = new Request('http://localhost:3000/api/ping', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = await response.json() as PingResponse;
      expect(responseData.message).toBe('pong');
      expect(responseData.requestId).toBe('req-123');
      expect(responseData.timestamp).toBeDefined();

      // Verify timestamp format
      expect(responseData.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Ping request',
        { requestId: 'req-123' }
      );
    });

    it('should include CORS headers in ping response', async () => {
      const request = new Request('http://localhost:3000/api/ping', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should handle ping requests with different HTTP methods', async () => {
      const methods = ['GET', 'POST', 'PUT'];
      
      for (const method of methods) {
        vi.clearAllMocks(); // Clear mocks between iterations
        
        const request = new Request('http://localhost:3000/api/ping', {
          method
        });

        const response = await miscHandler.handle(request, mockContext);

        expect(response.status).toBe(200);
        const responseData = await response.json() as PingResponse;
        expect(responseData.message).toBe('pong');

        expect(mockLogger.info).toHaveBeenCalledWith(
          'Ping request',
          { requestId: 'req-123' }
        );
      }
    });

    it('should return unique timestamps for multiple ping requests', async () => {
      const request1 = new Request('http://localhost:3000/api/ping', {
        method: 'GET'
      });
      const request2 = new Request('http://localhost:3000/api/ping', {
        method: 'GET'
      });

      const response1 = await miscHandler.handle(request1, mockContext);
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 5));
      const response2 = await miscHandler.handle(request2, mockContext);

      const responseData1 = await response1.json() as PingResponse;
      const responseData2 = await response2.json() as PingResponse;

      expect(responseData1.timestamp).not.toBe(responseData2.timestamp);
      expect(new Date(responseData1.timestamp).getTime()).toBeLessThan(
        new Date(responseData2.timestamp).getTime()
      );
    });
  });

  describe('handleCommands - GET /api/commands', () => {
    it('should return list of available commands', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = await response.json() as CommandsResponse;
      expect(responseData.availableCommands).toBeDefined();
      expect(Array.isArray(responseData.availableCommands)).toBe(true);
      expect(responseData.availableCommands.length).toBeGreaterThan(0);
      expect(responseData.timestamp).toBeDefined();

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Commands request',
        { requestId: 'req-123' }
      );
    });

    it('should include expected common commands', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);
      const responseData = await response.json() as CommandsResponse;

      const expectedCommands = [
        'ls', 'pwd', 'echo', 'cat', 'grep', 'find',
        'whoami', 'date', 'uptime', 'ps', 'top',
        'df', 'du', 'free', 'node', 'npm', 'git',
        'curl', 'wget'
      ];

      for (const command of expectedCommands) {
        expect(responseData.availableCommands).toContain(command);
      }

      // Verify exact count matches implementation
      expect(responseData.availableCommands).toHaveLength(19);
    });

    it('should return consistent command list across requests', async () => {
      const request1 = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });
      const request2 = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response1 = await miscHandler.handle(request1, mockContext);
      const response2 = await miscHandler.handle(request2, mockContext);

      const responseData1 = await response1.json() as CommandsResponse;
      const responseData2 = await response2.json() as CommandsResponse;

      expect(responseData1.availableCommands).toEqual(responseData2.availableCommands);
      expect(responseData1.availableCommands.length).toBe(responseData2.availableCommands.length);
    });

    it('should include CORS headers in commands response', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should return proper timestamp format', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);
      const responseData = await response.json() as CommandsResponse;

      expect(responseData.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);
    });

    it('should include essential system commands', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);
      const responseData = await response.json() as CommandsResponse;

      const essentialCommands = ['ls', 'cat', 'echo', 'pwd', 'whoami'];
      for (const command of essentialCommands) {
        expect(responseData.availableCommands).toContain(command);
      }
    });

    it('should include development tools', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);
      const responseData = await response.json() as CommandsResponse;

      const devTools = ['node', 'npm', 'git'];
      for (const tool of devTools) {
        expect(responseData.availableCommands).toContain(tool);
      }
    });

    it('should include network utilities', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);
      const responseData = await response.json() as CommandsResponse;

      const networkUtils = ['curl', 'wget'];
      for (const util of networkUtils) {
        expect(responseData.availableCommands).toContain(util);
      }
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid endpoints', async () => {
      const request = new Request('http://localhost:3000/invalid-endpoint', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid endpoint');

      // Should not log for invalid endpoints
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('should return 404 for non-existent API endpoints', async () => {
      const request = new Request('http://localhost:3000/api/nonexistent', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json() as HandlerErrorResponse;
      expect(responseData.error).toBe('Invalid endpoint');
    });

    it('should include CORS headers in 404 responses', async () => {
      const request = new Request('http://localhost:3000/invalid', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should have consistent JSON response structure for API endpoints', async () => {
      const apiEndpoints = [
        { path: '/api/ping', expectedFields: ['message', 'timestamp', 'requestId'] },
        { path: '/api/commands', expectedFields: ['availableCommands', 'timestamp'] }
      ];

      for (const endpoint of apiEndpoints) {
        const request = new Request(`http://localhost:3000${endpoint.path}`, {
          method: 'GET'
        });

        const response = await miscHandler.handle(request, mockContext);
        const responseData = await response.json() as CommandsResponse;

        // Verify all expected fields are present
        for (const field of endpoint.expectedFields) {
          expect(responseData).toHaveProperty(field);
        }

        // Verify timestamp is always present and properly formatted
        expect(responseData.timestamp).toBeDefined();
        expect(responseData.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    });

    it('should have proper Content-Type headers for different response types', async () => {
      const endpoints = [
        { path: '/', expectedContentType: 'text/plain; charset=utf-8' },
        { path: '/api/ping', expectedContentType: 'application/json' },
        { path: '/api/commands', expectedContentType: 'application/json' }
      ];

      for (const endpoint of endpoints) {
        const request = new Request(`http://localhost:3000${endpoint.path}`, {
          method: 'GET'
        });

        const response = await miscHandler.handle(request, mockContext);
        expect(response.headers.get('Content-Type')).toBe(endpoint.expectedContentType);
      }
    });

    it('should handle requests with different context properties', async () => {
      const alternativeContext: RequestContext = {
        requestId: 'req-alternative-456',
        timestamp: new Date(),
        corsHeaders: {
          'Access-Control-Allow-Origin': 'https://example.com',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Authorization',
        },
      };

      const request = new Request('http://localhost:3000/api/ping', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, alternativeContext);
      const responseData = await response.json() as PingResponse;

      expect(responseData.requestId).toBe('req-alternative-456');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
    });
  });

  describe('logging integration', () => {
    it('should log only API endpoint requests', async () => {
      const endpoints = [
        { path: '/', shouldLog: false },
        { path: '/api/ping', shouldLog: true },
        { path: '/api/commands', shouldLog: true },
        { path: '/invalid', shouldLog: false }
      ];

      for (const endpoint of endpoints) {
        vi.clearAllMocks();

        const request = new Request(`http://localhost:3000${endpoint.path}`, {
          method: 'GET'
        });

        await miscHandler.handle(request, mockContext);

        if (endpoint.shouldLog) {
          expect(mockLogger.info).toHaveBeenCalledTimes(1);
        } else {
          expect(mockLogger.info).not.toHaveBeenCalled();
        }
      }
    });

    it('should log with proper context for API requests', async () => {
      const request = new Request('http://localhost:3000/api/commands', {
        method: 'GET'
      });

      await miscHandler.handle(request, mockContext);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Commands request',
        { requestId: 'req-123' }
      );
    });
  });

  describe('no service dependencies', () => {
    it('should work without any service dependencies', async () => {
      // MiscHandler only requires logger, no other services
      const simpleLogger: Logger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      };

      const { MiscHandler: MiscHandlerClass } = await import('@container/handlers/misc-handler');
      const independentHandler = new MiscHandlerClass(simpleLogger);

      const request = new Request('http://localhost:3000/api/ping', {
        method: 'GET'
      });

      const response = await independentHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json() as PingResponse;
      expect(responseData.message).toBe('pong');
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored MiscHandler:
 * 
 * 1. **Utility Endpoint Testing**: Handler provides utility endpoints (root, ping,
 *    commands) with different response types and content formats.
 * 
 * 2. **Multiple Content Types**: Tests validate both text/plain responses (root)
 *    and application/json responses (API endpoints).
 * 
 * 3. **Static Data Testing**: Commands endpoint returns a hardcoded list, and
 *    tests verify the exact content and consistency.
 * 
 * 4. **Response Format Consistency**: Tests ensure consistent JSON structure,
 *    timestamp formatting, and proper Content-Type headers.
 * 
 * 5. **Logging Behavior**: Tests validate that only API endpoints generate logs,
 *    while utility endpoints (root) do not.
 * 
 * 6. **No Service Dependencies**: Handler only requires logger, demonstrating
 *    simple handlers without complex business logic.
 * 
 * 7. **CORS Header Validation**: Tests ensure CORS headers are included in all
 *    response types (text, JSON, errors).
 * 
 * 8. **Route Validation**: Tests cover valid endpoints and invalid endpoints
 *    with appropriate 404 responses.
 * 
 * 9. **Context Integration**: Tests validate that request context (requestId,
 *    CORS headers) is properly used in responses.
 * 
 * 10. **Timestamp Uniqueness**: Tests verify that timestamps are generated
 *     fresh for each request and properly formatted.
 * 
 * 11. **Command List Validation**: Tests verify specific commands are included
 *     (system tools, dev tools, network utilities) and list consistency.
 */