import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { HealthCheckResult, Logger, ShutdownResult } from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import type { RequestContext } from '@sandbox-container/core/types';
import {
  MiscHandler,
  type VersionResult
} from '@sandbox-container/handlers/misc-handler';

// Mock the dependencies
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

describe('MiscHandler', () => {
  let miscHandler: MiscHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    miscHandler = new MiscHandler(mockLogger);
  });

  describe('handleRoot - GET /', () => {
    it('should return welcome message with text/plain content type', async () => {
      const request = new Request('http://localhost:3000/', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Hello from Bun server! 🚀');
      expect(response.headers.get('Content-Type')).toBe(
        'text/plain; charset=utf-8'
      );
    });

    it('should include CORS headers in root response', async () => {
      const request = new Request('http://localhost:3000/', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
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

  describe('handleHealth - GET /api/health', () => {
    it('should return health check response with JSON content type', async () => {
      const request = new Request('http://localhost:3000/api/health', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = (await response.json()) as HealthCheckResult;
      expect(responseData.success).toBe(true);
      expect(responseData.status).toBe('healthy');
      expect(responseData.timestamp).toBeDefined();

      // Verify timestamp format
      expect(responseData.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);
    });

    it('should include CORS headers in health response', async () => {
      const request = new Request('http://localhost:3000/api/health', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
    });

    it('should handle health requests with different HTTP methods', async () => {
      const methods = ['GET', 'POST', 'PUT'];

      for (const method of methods) {
        vi.clearAllMocks(); // Clear mocks between iterations

        const request = new Request('http://localhost:3000/api/health', {
          method
        });

        const response = await miscHandler.handle(request, mockContext);

        expect(response.status).toBe(200);
        const responseData = (await response.json()) as HealthCheckResult;
        expect(responseData.success).toBe(true);
        expect(responseData.status).toBe('healthy');
      }
    });

    it('should return unique timestamps for multiple health requests', async () => {
      const request1 = new Request('http://localhost:3000/api/health', {
        method: 'GET'
      });
      const request2 = new Request('http://localhost:3000/api/health', {
        method: 'GET'
      });

      const response1 = await miscHandler.handle(request1, mockContext);
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response2 = await miscHandler.handle(request2, mockContext);

      const responseData1 = (await response1.json()) as HealthCheckResult;
      const responseData2 = (await response2.json()) as HealthCheckResult;

      expect(responseData1.timestamp).not.toBe(responseData2.timestamp);
      expect(new Date(responseData1.timestamp).getTime()).toBeLessThan(
        new Date(responseData2.timestamp).getTime()
      );
    });
  });

  describe('handleVersion - GET /api/version', () => {
    it('should return version from environment variable', async () => {
      // Set environment variable for test
      process.env.SANDBOX_VERSION = '1.2.3';

      const request = new Request('http://localhost:3000/api/version', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = (await response.json()) as VersionResult;
      expect(responseData.success).toBe(true);
      expect(responseData.version).toBe('1.2.3');
      expect(responseData.timestamp).toBeDefined();
      expect(responseData.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });

    it('should return "unknown" when SANDBOX_VERSION is not set', async () => {
      // Clear environment variable
      delete process.env.SANDBOX_VERSION;

      const request = new Request('http://localhost:3000/api/version', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as VersionResult;
      expect(responseData.version).toBe('unknown');
    });

    it('should include CORS headers in version response', async () => {
      process.env.SANDBOX_VERSION = '1.0.0';

      const request = new Request('http://localhost:3000/api/version', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
    });
  });

  describe('handleShutdown - POST /api/shutdown', () => {
    it('should return shutdown response with JSON content type', async () => {
      const request = new Request('http://localhost:3000/api/shutdown', {
        method: 'POST'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const responseData = (await response.json()) as ShutdownResult;
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('Container shutdown initiated');
      expect(responseData.timestamp).toBeDefined();

      // Verify timestamp format
      expect(responseData.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      expect(new Date(responseData.timestamp)).toBeInstanceOf(Date);
    });

    it('should include CORS headers in shutdown response', async () => {
      const request = new Request('http://localhost:3000/api/shutdown', {
        method: 'POST'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
    });

    it('should handle shutdown requests with GET method', async () => {
      const request = new Request('http://localhost:3000/api/shutdown', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as ShutdownResult;
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('Container shutdown initiated');
    });

    it('should return unique timestamps for multiple shutdown requests', async () => {
      const request1 = new Request('http://localhost:3000/api/shutdown', {
        method: 'POST'
      });
      const request2 = new Request('http://localhost:3000/api/shutdown', {
        method: 'POST'
      });

      const response1 = await miscHandler.handle(request1, mockContext);
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response2 = await miscHandler.handle(request2, mockContext);

      const responseData1 = (await response1.json()) as ShutdownResult;
      const responseData2 = (await response2.json()) as ShutdownResult;

      expect(responseData1.timestamp).not.toBe(responseData2.timestamp);
      expect(new Date(responseData1.timestamp).getTime()).toBeLessThan(
        new Date(responseData2.timestamp).getTime()
      );
    });
  });

  describe('route handling', () => {
    it('should return 500 for invalid endpoints', async () => {
      const request = new Request('http://localhost:3000/invalid-endpoint', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.message).toBe('Invalid endpoint');
      expect(responseData.code).toBeDefined();
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
      expect(responseData.context).toBeDefined();
    });

    it('should return 500 for non-existent API endpoints', async () => {
      const request = new Request('http://localhost:3000/api/nonexistent', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.message).toBe('Invalid endpoint');
      expect(responseData.code).toBeDefined();
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
      expect(responseData.context).toBeDefined();
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/invalid', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('response format consistency', () => {
    it('should have consistent JSON response structure for API endpoints', async () => {
      const apiEndpoints = [
        {
          path: '/api/health',
          expectedFields: ['success', 'status', 'timestamp']
        },
        {
          path: '/api/shutdown',
          expectedFields: ['success', 'message', 'timestamp']
        }
      ];

      for (const endpoint of apiEndpoints) {
        const request = new Request(`http://localhost:3000${endpoint.path}`, {
          method: 'GET'
        });

        const response = await miscHandler.handle(request, mockContext);
        const responseData = (await response.json()) as
          | HealthCheckResult
          | ShutdownResult;

        // Verify all expected fields are present
        expect(responseData.success).toBe(true);
        expect(responseData.timestamp).toBeDefined();
        expect(responseData.timestamp).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
        );

        // Verify all expected fields are present
        for (const field of endpoint.expectedFields) {
          expect(responseData).toHaveProperty(field);
        }
      }
    });

    it('should have proper Content-Type headers for different response types', async () => {
      const endpoints = [
        { path: '/', expectedContentType: 'text/plain; charset=utf-8' },
        { path: '/api/health', expectedContentType: 'application/json' },
        { path: '/api/shutdown', expectedContentType: 'application/json' }
      ];

      for (const endpoint of endpoints) {
        const request = new Request(`http://localhost:3000${endpoint.path}`, {
          method: 'GET'
        });

        const response = await miscHandler.handle(request, mockContext);
        expect(response.headers.get('Content-Type')).toBe(
          endpoint.expectedContentType
        );
      }
    });

    it('should handle requests with different context properties', async () => {
      const alternativeContext: RequestContext = {
        requestId: 'req-alternative-456',
        timestamp: new Date(),
        corsHeaders: {
          'Access-Control-Allow-Origin': 'https://example.com',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Authorization'
        },
        sessionId: 'session-alternative'
      };

      const request = new Request('http://localhost:3000/api/health', {
        method: 'GET'
      });

      const response = await miscHandler.handle(request, alternativeContext);
      const responseData = (await response.json()) as HealthCheckResult;

      expect(responseData.success).toBe(true);
      expect(responseData.status).toBe('healthy');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://example.com'
      );
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Authorization'
      );
    });
  });

  describe('no service dependencies', () => {
    it('should work without any service dependencies', async () => {
      // MiscHandler only requires logger, no other services
      const simpleLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn()
      } as Logger;
      simpleLogger.child = vi.fn(() => simpleLogger);

      const independentHandler = new MiscHandler(simpleLogger);

      const request = new Request('http://localhost:3000/api/health', {
        method: 'GET'
      });

      const response = await independentHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as HealthCheckResult;
      expect(responseData.success).toBe(true);
      expect(responseData.status).toBe('healthy');
    });
  });
});
