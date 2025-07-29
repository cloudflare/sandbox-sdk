/**
 * Port Handler Tests
 * 
 * Tests the PortHandler class from the refactored container architecture.
 * Demonstrates testing handlers with port management and proxying functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PortHandler } from '@container/handlers/port-handler';
import type { PortService } from '@container/services/port-service';
import type { Logger, RequestContext, PortInfo } from '@container/core/types';

// Mock the dependencies
const mockPortService: PortService = {
  exposePort: vi.fn(),
  unexposePort: vi.fn(),
  getExposedPorts: vi.fn(),
  getPortInfo: vi.fn(),
  proxyRequest: vi.fn(),
  markPortInactive: vi.fn(),
  cleanupInactivePorts: vi.fn(),
  destroy: vi.fn(),
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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  sessionId: 'session-456',
  validatedData: {}, // Will be set per test
};

describe('PortHandler', () => {
  let portHandler: PortHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Import the PortHandler (dynamic import)
    const { PortHandler: PortHandlerClass } = await import('@container/handlers/port-handler');
    portHandler = new PortHandlerClass(mockPortService, mockLogger);
  });

  describe('handleExpose - POST /api/expose-port', () => {
    it('should expose port successfully', async () => {
      const exposePortData = {
        port: 8080,
        name: 'web-server'
      };

      const mockPortInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        status: 'active',
        exposedAt: new Date('2023-01-01T00:00:00Z'),
      };

      mockContext.validatedData = exposePortData;
      (mockPortService.exposePort as any).mockResolvedValue({
        success: true,
        data: mockPortInfo
      });

      const request = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exposePortData)
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.port).toBe(8080);
      expect(responseData.name).toBe('web-server');
      expect(responseData.exposedAt).toBe('2023-01-01T00:00:00.000Z');

      // Verify service was called correctly
      expect(mockPortService.exposePort).toHaveBeenCalledWith(8080, 'web-server');

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Exposing port',
        expect.objectContaining({
          requestId: 'req-123',
          port: 8080,
          name: 'web-server'
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port exposed successfully',
        expect.objectContaining({
          requestId: 'req-123',
          port: 8080,
          name: 'web-server'
        })
      );
    });

    it('should expose port without name', async () => {
      const exposePortData = {
        port: 3000
        // name not provided
      };

      const mockPortInfo: PortInfo = {
        port: 3000,
        status: 'active',
        exposedAt: new Date('2023-01-01T00:00:00Z'),
      };

      mockContext.validatedData = exposePortData;
      (mockPortService.exposePort as any).mockResolvedValue({
        success: true,
        data: mockPortInfo
      });

      const request = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exposePortData)
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.port).toBe(3000);
      expect(responseData.name).toBeUndefined();

      expect(mockPortService.exposePort).toHaveBeenCalledWith(3000, undefined);
    });

    it('should handle port expose failures', async () => {
      const exposePortData = { port: 80 }; // Invalid port
      mockContext.validatedData = exposePortData;

      (mockPortService.exposePort as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Port 80 is reserved',
          code: 'INVALID_PORT',
          details: { port: 80 }
        }
      });

      const request = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exposePortData)
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.success).toBe(false);
      expect(responseData.code).toBe('INVALID_PORT');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Port expose failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          port: 80,
          errorCode: 'INVALID_PORT'
        })
      );
    });

    it('should handle port already exposed error', async () => {
      const exposePortData = { port: 8080 };
      mockContext.validatedData = exposePortData;

      (mockPortService.exposePort as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Port 8080 is already exposed',
          code: 'PORT_ALREADY_EXPOSED'
        }
      });

      const request = new Request('http://localhost:3000/api/expose-port', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exposePortData)
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.code).toBe('PORT_ALREADY_EXPOSED');
    });
  });

  describe('handleUnexpose - DELETE /api/exposed-ports/{port}', () => {
    it('should unexpose port successfully', async () => {
      (mockPortService.unexposePort as any).mockResolvedValue({
        success: true
      });

      const request = new Request('http://localhost:3000/api/exposed-ports/8080', {
        method: 'DELETE'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.message).toBe('Port unexposed successfully');
      expect(responseData.port).toBe(8080);

      expect(mockPortService.unexposePort).toHaveBeenCalledWith(8080);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Unexposing port',
        expect.objectContaining({
          requestId: 'req-123',
          port: 8080
        })
      );
    });

    it('should handle unexpose failures', async () => {
      (mockPortService.unexposePort as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Port 8080 is not exposed',
          code: 'PORT_NOT_EXPOSED'
        }
      });

      const request = new Request('http://localhost:3000/api/exposed-ports/8080', {
        method: 'DELETE'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.code).toBe('PORT_NOT_EXPOSED');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Port unexpose failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          port: 8080,
          errorCode: 'PORT_NOT_EXPOSED'
        })
      );
    });

    it('should handle invalid port numbers in URL', async () => {
      const request = new Request('http://localhost:3000/api/exposed-ports/invalid', {
        method: 'DELETE'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid port endpoint');

      // Should not call service for invalid port
      expect(mockPortService.unexposePort).not.toHaveBeenCalled();
    });

    it('should handle unsupported methods on exposed-ports endpoint', async () => {
      const request = new Request('http://localhost:3000/api/exposed-ports/8080', {
        method: 'GET' // Not supported for individual ports
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid port endpoint');
    });
  });

  describe('handleList - GET /api/exposed-ports', () => {
    it('should list exposed ports successfully', async () => {
      const mockPorts: PortInfo[] = [
        {
          port: 8080,
          name: 'web-server',
          status: 'active',
          exposedAt: new Date('2023-01-01T00:00:00Z'),
        },
        {
          port: 3000,
          name: 'api-server',
          status: 'active',
          exposedAt: new Date('2023-01-01T00:01:00Z'),
        }
      ];

      (mockPortService.getExposedPorts as any).mockResolvedValue({
        success: true,
        data: mockPorts
      });

      const request = new Request('http://localhost:3000/api/exposed-ports', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.count).toBe(2);
      expect(responseData.ports).toHaveLength(2);
      expect(responseData.ports[0].port).toBe(8080);
      expect(responseData.ports[0].name).toBe('web-server');
      expect(responseData.ports[1].port).toBe(3000);

      expect(mockPortService.getExposedPorts).toHaveBeenCalled();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Listing exposed ports',
        { requestId: 'req-123' }
      );
    });

    it('should return empty list when no ports are exposed', async () => {
      (mockPortService.getExposedPorts as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/exposed-ports', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);
      expect(responseData.count).toBe(0);
      expect(responseData.ports).toHaveLength(0);
    });

    it('should handle port listing errors', async () => {
      (mockPortService.getExposedPorts as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Database error',
          code: 'PORT_LIST_ERROR'
        }
      });

      const request = new Request('http://localhost:3000/api/exposed-ports', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.code).toBe('PORT_LIST_ERROR');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Port listing failed',
        undefined,
        expect.objectContaining({
          requestId: 'req-123',
          errorCode: 'PORT_LIST_ERROR'
        })
      );
    });
  });

  describe('handleProxy - GET /proxy/{port}/*', () => {
    it('should proxy request successfully', async () => {
      const mockProxyResponse = new Response('Proxied content', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });

      (mockPortService.proxyRequest as any).mockResolvedValue(mockProxyResponse);

      const request = new Request('http://localhost:3000/proxy/8080/api/data', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer token' }
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Proxied content');
      expect(response.headers.get('Content-Type')).toBe('text/html');

      // Verify service was called with correct parameters
      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(8080, request);

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Proxying request',
        expect.objectContaining({
          requestId: 'req-123',
          port: 8080,
          method: 'GET',
          originalPath: '/proxy/8080/api/data'
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Proxy request completed',
        expect.objectContaining({
          requestId: 'req-123',
          port: 8080,
          status: 200
        })
      );
    });

    it('should proxy POST request with body', async () => {
      const mockProxyResponse = new Response('{"success": true}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });

      (mockPortService.proxyRequest as any).mockResolvedValue(mockProxyResponse);

      const requestBody = JSON.stringify({ data: 'test' });
      const request = new Request('http://localhost:3000/proxy/3000/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(201);
      const responseData = await response.json();
      expect(responseData.success).toBe(true);

      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(3000, request);
    });

    it('should handle proxy errors from service', async () => {
      const mockErrorResponse = new Response('{"error": "Port not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });

      (mockPortService.proxyRequest as any).mockResolvedValue(mockErrorResponse);

      const request = new Request('http://localhost:3000/proxy/9999/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Port not found');
    });

    it('should handle invalid proxy URL format', async () => {
      const request = new Request('http://localhost:3000/proxy/', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid port number in proxy URL');

      // Should not call proxy service
      expect(mockPortService.proxyRequest).not.toHaveBeenCalled();
    });

    it('should handle invalid port number in proxy URL', async () => {
      const request = new Request('http://localhost:3000/proxy/invalid-port/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid port number in proxy URL');

      expect(mockPortService.proxyRequest).not.toHaveBeenCalled();
    });

    it('should handle proxy service exceptions', async () => {
      const proxyError = new Error('Connection refused');
      (mockPortService.proxyRequest as any).mockRejectedValue(proxyError);

      const request = new Request('http://localhost:3000/proxy/8080/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(502);
      const responseData = await response.json();
      expect(responseData.error).toBe('Connection refused');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Proxy request failed',
        proxyError,
        expect.objectContaining({
          requestId: 'req-123'
        })
      );
    });

    it('should handle non-Error exceptions in proxy', async () => {
      (mockPortService.proxyRequest as any).mockRejectedValue('String error');

      const request = new Request('http://localhost:3000/proxy/8080/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(502);
      const responseData = await response.json();
      expect(responseData.error).toBe('Proxy request failed');
    });
  });

  describe('route handling', () => {
    it('should return 404 for invalid endpoints', async () => {
      const request = new Request('http://localhost:3000/api/invalid-endpoint', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid port endpoint');
    });

    it('should handle malformed exposed-ports URLs', async () => {
      const request = new Request('http://localhost:3000/api/exposed-ports/', {
        method: 'DELETE'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Invalid port endpoint');
    });

    it('should handle root proxy path', async () => {
      const mockProxyResponse = new Response('Root page');
      (mockPortService.proxyRequest as any).mockResolvedValue(mockProxyResponse);

      const request = new Request('http://localhost:3000/proxy/8080/', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Root page');
      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(8080, request);
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers in successful responses', async () => {
      (mockPortService.getExposedPorts as any).mockResolvedValue({
        success: true,
        data: []
      });

      const request = new Request('http://localhost:3000/api/exposed-ports', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/invalid', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('URL parsing edge cases', () => {
    it('should handle ports with leading zeros', async () => {
      const request = new Request('http://localhost:3000/api/exposed-ports/008080', {
        method: 'DELETE'
      });

      (mockPortService.unexposePort as any).mockResolvedValue({ success: true });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      // parseInt should handle leading zeros correctly
      expect(mockPortService.unexposePort).toHaveBeenCalledWith(8080);
    });

    it('should handle very large port numbers', async () => {
      const request = new Request('http://localhost:3000/api/exposed-ports/999999', {
        method: 'DELETE'
      });

      (mockPortService.unexposePort as any).mockResolvedValue({
        success: false,
        error: { message: 'Invalid port range', code: 'INVALID_PORT' }
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      expect(mockPortService.unexposePort).toHaveBeenCalledWith(999999);
    });

    it('should handle complex proxy paths with query parameters', async () => {
      const mockProxyResponse = new Response('Query result');
      (mockPortService.proxyRequest as any).mockResolvedValue(mockProxyResponse);

      const request = new Request('http://localhost:3000/proxy/8080/api/search?q=test&page=1', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(8080, request);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Proxying request',
        expect.objectContaining({
          originalPath: '/proxy/8080/api/search'
        })
      );
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored PortHandler:
 * 
 * 1. **Port Management Testing**: Handler manages port exposure, unexposing, and
 *    listing with proper validation and error handling.
 * 
 * 2. **Dynamic Route Handling**: Tests validate URL parsing for dynamic routes
 *    like /api/exposed-ports/{port} and /proxy/{port}/path.
 * 
 * 3. **Request Proxying**: Complete proxy functionality testing including request
 *    forwarding, response handling, and error scenarios.
 * 
 * 4. **URL Parsing Edge Cases**: Tests cover malformed URLs, invalid port numbers,
 *    complex paths with query parameters, and various edge cases.
 * 
 * 5. **ServiceResult Integration**: Handler converts PortService ServiceResult
 *    objects into appropriate HTTP responses with correct status codes.
 * 
 * 6. **Error Response Testing**: All error scenarios are tested including service
 *    failures, invalid requests, and proxy errors.
 * 
 * 7. **HTTP Method Validation**: Tests ensure only supported HTTP methods are
 *    handled for each endpoint.
 * 
 * 8. **Logging Integration**: Tests validate comprehensive logging for operations,
 *    successes, errors, and proxy requests.
 * 
 * 9. **CORS Header Validation**: Tests ensure CORS headers are included in both
 *    success and error responses.
 * 
 * 10. **Proxy Response Passthrough**: Tests validate that proxy responses (headers,
 *     status codes, body) are properly passed through from the target service.
 */