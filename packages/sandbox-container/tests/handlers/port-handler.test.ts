import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type {
  Logger,
  PortCloseResult,
  PortExposeResult,
  PortListResult
} from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type {
  PortInfo,
  ProxyErrorResponse,
  RequestContext
} from '@sandbox-container/core/types';
import { PortHandler } from '@sandbox-container/handlers/port-handler';
import type { PortService } from '@sandbox-container/services/port-service';

// Test-specific type for mock proxy response
// The proxy handler passes through responses from the target service unchanged,
// so the shape depends on what the target returns. This type represents our test mock.
interface MockProxySuccessResponse {
  success: boolean;
}

// Mock the dependencies - use partial mock to avoid private property issues
const mockPortService = {
  exposePort: vi.fn(),
  unexposePort: vi.fn(),
  getExposedPorts: vi.fn(),
  getPortInfo: vi.fn(),
  proxyRequest: vi.fn(),
  markPortInactive: vi.fn(),
  cleanupInactivePorts: vi.fn(),
  destroy: vi.fn()
} as unknown as PortService;

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

describe('PortHandler', () => {
  let portHandler: PortHandler;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    portHandler = new PortHandler(mockPortService, mockLogger);
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
        exposedAt: new Date('2023-01-01T00:00:00Z')
      };

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
      const responseData = (await response.json()) as PortExposeResult;
      expect(responseData.success).toBe(true);
      expect(responseData.port).toBe(8080);
      expect(responseData.url).toBe('http://localhost:8080');
      expect(responseData.timestamp).toBeDefined();

      // Verify service was called correctly
      expect(mockPortService.exposePort).toHaveBeenCalledWith(
        8080,
        'web-server'
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
        exposedAt: new Date('2023-01-01T00:00:00Z')
      };

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
      const responseData = (await response.json()) as PortExposeResult;
      expect(responseData.port).toBe(3000);
      expect(responseData.url).toBe('http://localhost:3000');
      expect(responseData.timestamp).toBeDefined();

      expect(mockPortService.exposePort).toHaveBeenCalledWith(3000, undefined);
    });

    it('should handle port expose failures', async () => {
      const exposePortData = { port: 80 }; // Invalid port

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
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('INVALID_PORT');
      expect(responseData.message).toBe('Port 80 is reserved');
      expect(responseData.httpStatus).toBe(400);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle port already exposed error', async () => {
      const exposePortData = { port: 8080 };

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

      expect(response.status).toBe(409);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('PORT_ALREADY_EXPOSED');
      expect(responseData.message).toBe('Port 8080 is already exposed');
      expect(responseData.httpStatus).toBe(409);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleUnexpose - DELETE /api/exposed-ports/{port}', () => {
    it('should unexpose port successfully', async () => {
      (mockPortService.unexposePort as any).mockResolvedValue({
        success: true
      });

      const request = new Request(
        'http://localhost:3000/api/exposed-ports/8080',
        {
          method: 'DELETE'
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      const responseData = (await response.json()) as PortCloseResult;
      expect(responseData.success).toBe(true);
      expect(responseData.port).toBe(8080);
      expect(responseData.timestamp).toBeDefined();

      expect(mockPortService.unexposePort).toHaveBeenCalledWith(8080);
    });

    it('should handle unexpose failures', async () => {
      (mockPortService.unexposePort as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Port 8080 is not exposed',
          code: 'PORT_NOT_EXPOSED'
        }
      });

      const request = new Request(
        'http://localhost:3000/api/exposed-ports/8080',
        {
          method: 'DELETE'
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('PORT_NOT_EXPOSED');
      expect(responseData.message).toBe('Port 8080 is not exposed');
      expect(responseData.httpStatus).toBe(404);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle invalid port numbers in URL', async () => {
      const request = new Request(
        'http://localhost:3000/api/exposed-ports/invalid',
        {
          method: 'DELETE'
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid port endpoint');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();

      // Should not call service for invalid port
      expect(mockPortService.unexposePort).not.toHaveBeenCalled();
    });

    it('should handle unsupported methods on exposed-ports endpoint', async () => {
      const request = new Request(
        'http://localhost:3000/api/exposed-ports/8080',
        {
          method: 'GET' // Not supported for individual ports
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid port endpoint');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleList - GET /api/exposed-ports', () => {
    it('should list exposed ports successfully', async () => {
      const mockPorts: PortInfo[] = [
        {
          port: 8080,
          name: 'web-server',
          status: 'active',
          exposedAt: new Date('2023-01-01T00:00:00Z')
        },
        {
          port: 3000,
          name: 'api-server',
          status: 'active',
          exposedAt: new Date('2023-01-01T00:01:00Z')
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
      const responseData = (await response.json()) as PortListResult;
      expect(responseData.success).toBe(true);
      expect(responseData.ports).toHaveLength(2);
      expect(responseData.ports[0].port).toBe(8080);
      expect(responseData.ports[0].url).toBe('http://localhost:8080');
      expect(responseData.ports[0].status).toBe('active');
      expect(responseData.ports[1].port).toBe(3000);
      expect(responseData.ports[1].url).toBe('http://localhost:3000');
      expect(responseData.timestamp).toBeDefined();

      expect(mockPortService.getExposedPorts).toHaveBeenCalled();
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
      const responseData = (await response.json()) as PortListResult;
      expect(responseData.success).toBe(true);
      expect(responseData.ports).toHaveLength(0);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle port listing errors', async () => {
      (mockPortService.getExposedPorts as any).mockResolvedValue({
        success: false,
        error: {
          message: 'Database error',
          code: ErrorCode.PORT_OPERATION_ERROR
        }
      });

      const request = new Request('http://localhost:3000/api/exposed-ports', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe(ErrorCode.PORT_OPERATION_ERROR);
      expect(responseData.message).toBe('Database error');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('handleProxy - GET /proxy/{port}/*', () => {
    it('should proxy request successfully', async () => {
      const mockProxyResponse = new Response('Proxied content', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });

      (mockPortService.proxyRequest as any).mockResolvedValue(
        mockProxyResponse
      );

      const request = new Request('http://localhost:3000/proxy/8080/api/data', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Proxied content');
      expect(response.headers.get('Content-Type')).toBe('text/html');

      // Verify service was called with correct parameters
      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(8080, request);
    });

    it('should proxy POST request with body', async () => {
      const mockProxyResponse = new Response('{"success": true}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });

      (mockPortService.proxyRequest as any).mockResolvedValue(
        mockProxyResponse
      );

      const requestBody = JSON.stringify({ data: 'test' });
      const request = new Request(
        'http://localhost:3000/proxy/3000/api/create',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(201);
      const responseData = (await response.json()) as MockProxySuccessResponse;
      expect(responseData.success).toBe(true);

      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(3000, request);
    });

    it('should handle proxy errors from service', async () => {
      const mockErrorResponse = new Response('{"error": "Port not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });

      (mockPortService.proxyRequest as any).mockResolvedValue(
        mockErrorResponse
      );

      const request = new Request('http://localhost:3000/proxy/9999/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(404);
      const responseData = (await response.json()) as ProxyErrorResponse;
      expect(responseData.error).toBe('Port not found');
    });

    it('should handle invalid proxy URL format', async () => {
      const request = new Request('http://localhost:3000/proxy/', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid port number in proxy URL');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();

      // Should not call proxy service
      expect(mockPortService.proxyRequest).not.toHaveBeenCalled();
    });

    it('should handle invalid port number in proxy URL', async () => {
      const request = new Request(
        'http://localhost:3000/proxy/invalid-port/api/data',
        {
          method: 'GET'
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid port number in proxy URL');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();

      expect(mockPortService.proxyRequest).not.toHaveBeenCalled();
    });

    it('should handle proxy service exceptions', async () => {
      const proxyError = new Error('Connection refused');
      (mockPortService.proxyRequest as any).mockRejectedValue(proxyError);

      const request = new Request('http://localhost:3000/proxy/8080/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Connection refused');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle non-Error exceptions in proxy', async () => {
      (mockPortService.proxyRequest as any).mockRejectedValue('String error');

      const request = new Request('http://localhost:3000/proxy/8080/api/data', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Proxy request failed');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });
  });

  describe('route handling', () => {
    it('should return 500 for invalid endpoints', async () => {
      const request = new Request(
        'http://localhost:3000/api/invalid-endpoint',
        {
          method: 'GET'
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid port endpoint');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle malformed exposed-ports URLs', async () => {
      const request = new Request('http://localhost:3000/api/exposed-ports/', {
        method: 'DELETE'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(responseData.message).toBe('Invalid port endpoint');
      expect(responseData.httpStatus).toBe(500);
      expect(responseData.timestamp).toBeDefined();
    });

    it('should handle root proxy path', async () => {
      const mockProxyResponse = new Response('Root page');
      (mockPortService.proxyRequest as any).mockResolvedValue(
        mockProxyResponse
      );

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
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        'GET, POST, DELETE, OPTIONS'
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        'Content-Type'
      );
    });

    it('should include CORS headers in error responses', async () => {
      const request = new Request('http://localhost:3000/api/invalid', {
        method: 'GET'
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(500);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('UNKNOWN_ERROR');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('URL parsing edge cases', () => {
    it('should handle ports with leading zeros', async () => {
      const request = new Request(
        'http://localhost:3000/api/exposed-ports/008080',
        {
          method: 'DELETE'
        }
      );

      (mockPortService.unexposePort as any).mockResolvedValue({
        success: true
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      // parseInt should handle leading zeros correctly
      expect(mockPortService.unexposePort).toHaveBeenCalledWith(8080);
    });

    it('should handle very large port numbers', async () => {
      const request = new Request(
        'http://localhost:3000/api/exposed-ports/999999',
        {
          method: 'DELETE'
        }
      );

      (mockPortService.unexposePort as any).mockResolvedValue({
        success: false,
        error: { message: 'Invalid port range', code: 'INVALID_PORT' }
      });

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as ErrorResponse;
      expect(responseData.code).toBe('INVALID_PORT');
      expect(responseData.message).toBe('Invalid port range');
      expect(responseData.httpStatus).toBe(400);
      expect(responseData.timestamp).toBeDefined();
      expect(mockPortService.unexposePort).toHaveBeenCalledWith(999999);
    });

    it('should handle complex proxy paths with query parameters', async () => {
      const mockProxyResponse = new Response('Query result');
      (mockPortService.proxyRequest as any).mockResolvedValue(
        mockProxyResponse
      );

      const request = new Request(
        'http://localhost:3000/proxy/8080/api/search?q=test&page=1',
        {
          method: 'GET'
        }
      );

      const response = await portHandler.handle(request, mockContext);

      expect(response.status).toBe(200);
      expect(mockPortService.proxyRequest).toHaveBeenCalledWith(8080, request);
    });
  });
});
