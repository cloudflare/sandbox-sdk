/**
 * Port Service Tests
 * 
 * Tests the PortService class from the refactored container architecture.
 * Demonstrates testing services with port management and proxying functionality.
 */

import type { PortService, PortStore, SecurityService } from '@container/services/port-service';
import type { Logger, PortInfo, PortNotFoundResponse, ProxyErrorResponse } from '@container/core/types';

// Mock the dependencies
const mockPortStore: PortStore = {
  expose: vi.fn(),
  unexpose: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn(),
};

const mockSecurityService: SecurityService = {
  validatePort: vi.fn(),
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock fetch for proxy testing
const mockFetch = vi.fn();
let originalFetch: typeof fetch;

describe('PortService', () => {
  let portService: PortService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Set up fetch mock for this test file
    originalFetch = global.fetch;
    global.fetch = mockFetch;
    
    // Set up fake timers for lifecycle testing
    vi.useFakeTimers();
    
    // Set up default successful security validation
    (mockSecurityService.validatePort as any).mockReturnValue({
      isValid: true,
      errors: []
    });

    // Import the PortService (dynamic import)
    const { PortService: PortServiceClass } = await import('@container/services/port-service');
    portService = new PortServiceClass(
      mockPortStore,
      mockSecurityService,
      mockLogger
    );
  });

  afterEach(() => {
    // Clean up timers and destroy service
    portService.destroy();
    vi.useRealTimers();
    
    // Restore original fetch to prevent test interference
    global.fetch = originalFetch;
  });

  describe('exposePort', () => {
    it('should expose port successfully with valid port number', async () => {
      (mockPortStore.get as any).mockResolvedValue(null); // Port not already exposed

      const result = await portService.exposePort(8080, 'web-server');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.port).toBe(8080);
        expect(result.data.name).toBe('web-server');
        expect(result.data.status).toBe('active');
        expect(result.data.exposedAt).toBeInstanceOf(Date);
      }

      // Verify security validation was called
      expect(mockSecurityService.validatePort).toHaveBeenCalledWith(8080);
      
      // Verify store was called
      expect(mockPortStore.expose).toHaveBeenCalledWith(
        8080,
        expect.objectContaining({
          port: 8080,
          name: 'web-server',
          status: 'active',
          exposedAt: expect.any(Date),
        })
      );

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port exposed successfully',
        { port: 8080, name: 'web-server' }
      );
    });

    it('should expose port without name when name is not provided', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);

      const result = await portService.exposePort(3000);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.port).toBe(3000);
        expect(result.data.name).toBeUndefined();
      }
    });

    it('should return error when port validation fails', async () => {
      (mockSecurityService.validatePort as any).mockReturnValue({
        isValid: false,
        errors: ['Port must be between 1024-65535', 'Port 80 is reserved']
      });

      const result = await portService.exposePort(80);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_PORT');
        expect(result.error.message).toContain('Port must be between 1024-65535');
        expect(result.error.details?.port).toBe(80);
        expect(result.error.details?.errors).toEqual([
          'Port must be between 1024-65535',
          'Port 80 is reserved'
        ]);
      }

      // Should not attempt to store port
      expect(mockPortStore.expose).not.toHaveBeenCalled();
    });

    it('should return error when port is already exposed', async () => {
      const existingPortInfo: PortInfo = {
        port: 8080,
        name: 'existing-service',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(existingPortInfo);

      const result = await portService.exposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_ALREADY_EXPOSED');
        expect(result.error.message).toBe('Port 8080 is already exposed');
        expect(result.error.details?.existing).toEqual(existingPortInfo);
      }

      // Should not attempt to expose again
      expect(mockPortStore.expose).not.toHaveBeenCalled();
    });

    it('should handle store errors gracefully', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);
      const storeError = new Error('Store connection failed');
      (mockPortStore.expose as any).mockRejectedValue(storeError);

      const result = await portService.exposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_EXPOSE_ERROR');
        expect(result.error.details?.originalError).toBe('Store connection failed');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to expose port',
        storeError,
        { port: 8080, name: undefined }
      );
    });
  });

  describe('unexposePort', () => {
    it('should unexpose port successfully when port is exposed', async () => {
      const existingPortInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(existingPortInfo);

      const result = await portService.unexposePort(8080);

      expect(result.success).toBe(true);
      expect(mockPortStore.unexpose).toHaveBeenCalledWith(8080);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port unexposed successfully',
        { port: 8080 }
      );
    });

    it('should return error when port is not exposed', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);

      const result = await portService.unexposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_NOT_EXPOSED');
        expect(result.error.message).toBe('Port 8080 is not exposed');
      }

      // Should not attempt to unexpose
      expect(mockPortStore.unexpose).not.toHaveBeenCalled();
    });

    it('should handle store errors during unexpose', async () => {
      const existingPortInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(existingPortInfo);
      const storeError = new Error('Unexpose failed');
      (mockPortStore.unexpose as any).mockRejectedValue(storeError);

      const result = await portService.unexposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_UNEXPOSE_ERROR');
      }
    });
  });

  describe('getExposedPorts', () => {
    it('should return list of all exposed ports', async () => {
      const mockPorts = [
        {
          port: 8080,
          info: {
            port: 8080,
            name: 'web-server',
            exposedAt: new Date(),
            status: 'active' as const,
          }
        },
        {
          port: 3000,
          info: {
            port: 3000,
            name: 'api-server',
            exposedAt: new Date(),
            status: 'inactive' as const,
          }
        }
      ];
      (mockPortStore.list as any).mockResolvedValue(mockPorts);

      const result = await portService.getExposedPorts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].port).toBe(8080);
        expect(result.data[0].name).toBe('web-server');
        expect(result.data[1].port).toBe(3000);
        expect(result.data[1].name).toBe('api-server');
      }
    });

    it('should return empty array when no ports are exposed', async () => {
      (mockPortStore.list as any).mockResolvedValue([]);

      const result = await portService.getExposedPorts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('should handle store list errors', async () => {
      const listError = new Error('Store list failed');
      (mockPortStore.list as any).mockRejectedValue(listError);

      const result = await portService.getExposedPorts();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_LIST_ERROR');
      }
    });
  });

  describe('getPortInfo', () => {
    it('should return port info when port is exposed', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(portInfo);

      const result = await portService.getPortInfo(8080);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(portInfo);
      }
    });

    it('should return error when port is not found', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);

      const result = await portService.getPortInfo(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_NOT_FOUND');
        expect(result.error.message).toBe('Port 8080 is not exposed');
      }
    });
  });

  describe('proxyRequest', () => {
    it('should proxy request successfully to exposed port', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(portInfo);

      const mockResponse = new Response('Hello World', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
      mockFetch.mockResolvedValue(mockResponse);

      const testRequest = new Request('http://example.com/proxy/8080/api/test?param=value', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer token' }
      });

      const response = await portService.proxyRequest(8080, testRequest);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Hello World');

      // Verify fetch was called with correct proxy URL
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(Request)
      );
      
      const fetchCall = mockFetch.mock.calls[0][0] as Request;
      expect(fetchCall.url).toBe('http://localhost:8080/api/test?param=value');
      expect(fetchCall.method).toBe('GET');

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Proxying request',
        expect.objectContaining({
          port: 8080,
          originalPath: '/proxy/8080/api/test',
          targetPath: 'api/test',
          targetUrl: 'http://localhost:8080/api/test?param=value'
        })
      );
    });

    it('should return 404 when port is not exposed', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);

      const testRequest = new Request('http://example.com/proxy/8080/api/test');
      const response = await portService.proxyRequest(8080, testRequest);

      expect(response.status).toBe(404);
      const responseData = await response.json() as PortNotFoundResponse;
      expect(responseData.error).toBe('Port not found');
      expect(responseData.port).toBe(8080);

      // Should not attempt to fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle proxy fetch errors gracefully', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(portInfo);

      const fetchError = new Error('Connection refused');
      mockFetch.mockRejectedValue(fetchError);

      const testRequest = new Request('http://example.com/proxy/8080/api/test');
      const response = await portService.proxyRequest(8080, testRequest);

      expect(response.status).toBe(502);
      const responseData = await response.json() as ProxyErrorResponse;
      expect(responseData.error).toBe('Proxy error');
      expect(responseData.message).toContain('Connection refused');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Proxy request failed',
        fetchError,
        { port: 8080 }
      );
    });

    it('should handle root path proxy correctly', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(portInfo);

      const mockResponse = new Response('Root page');
      mockFetch.mockResolvedValue(mockResponse);

      const testRequest = new Request('http://example.com/proxy/8080/');
      await portService.proxyRequest(8080, testRequest);

      // Should proxy to root path
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(Request)
      );
      
      const fetchCall = mockFetch.mock.calls[0][0] as Request;
      expect(fetchCall.url).toBe('http://localhost:8080/');
    });
  });

  describe('markPortInactive', () => {
    it('should mark port as inactive successfully', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active',
      };
      (mockPortStore.get as any).mockResolvedValue(portInfo);
      (mockPortStore.expose as any).mockResolvedValue(undefined);

      const result = await portService.markPortInactive(8080);

      expect(result.success).toBe(true);
      
      // Should update port status in store
      expect(mockPortStore.expose).toHaveBeenCalledWith(
        8080,
        expect.objectContaining({
          ...portInfo,
          status: 'inactive'
        })
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Port marked as inactive',
        { port: 8080 }
      );
    });

    it('should return error when port is not found', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);

      const result = await portService.markPortInactive(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_NOT_FOUND');
      }

      // Should not attempt to update
      expect(mockPortStore.expose).not.toHaveBeenCalled();
    });
  });

  describe('cleanupInactivePorts', () => {
    it('should cleanup inactive ports and return count', async () => {
      (mockPortStore.cleanup as any).mockResolvedValue(3);

      const result = await portService.cleanupInactivePorts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(3);
      }

      // Verify cleanup was called with 1 hour ago threshold
      expect(mockPortStore.cleanup).toHaveBeenCalledWith(
        expect.any(Date)
      );

      // Verify logging when ports were cleaned
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleaned up inactive ports',
        { count: 3 }
      );
    });

    it('should not log when no ports are cleaned', async () => {
      (mockPortStore.cleanup as any).mockResolvedValue(0);

      const result = await portService.cleanupInactivePorts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(0);
      }

      // Should not log when count is 0
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'Cleaned up inactive ports',
        expect.any(Object)
      );
    });

    it('should handle cleanup errors', async () => {
      const cleanupError = new Error('Cleanup failed');
      (mockPortStore.cleanup as any).mockRejectedValue(cleanupError);

      const result = await portService.cleanupInactivePorts();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_CLEANUP_ERROR');
      }
    });
  });

  describe('lifecycle management', () => {
    it('should start cleanup interval on construction', () => {
      // Verify that setInterval was called (constructor starts cleanup process)
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it('should cleanup interval on destroy', () => {
      const initialTimerCount = vi.getTimerCount();
      
      portService.destroy();
      
      // Should have fewer timers after destroy
      expect(vi.getTimerCount()).toBeLessThan(initialTimerCount);
    });

    it('should run automatic cleanup every hour', async () => {
      (mockPortStore.cleanup as any).mockResolvedValue(1);

      // Fast-forward 1 hour
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // Verify cleanup was called
      expect(mockPortStore.cleanup).toHaveBeenCalled();
    });
  });

  describe('error handling patterns', () => {
    it('should handle non-Error exceptions consistently', async () => {
      (mockPortStore.get as any).mockResolvedValue(null);
      (mockPortStore.expose as any).mockRejectedValue('String error');

      const result = await portService.exposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.originalError).toBe('Unknown error');
      }
    });

    it('should include proper context in all error responses', async () => {
      const testPort = 8080;
      (mockPortStore.get as any).mockResolvedValue(null);

      const result = await portService.unexposePort(testPort);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.port).toBe(testPort);
        expect(result.error.message).toContain(testPort.toString());
      }
    });
  });
});

/**
 * This test demonstrates several key patterns for testing the refactored PortService:
 * 
 * 1. **Multi-Dependency Testing**: PortService depends on PortStore, SecurityService,
 *    and Logger, all easily mocked through constructor injection.
 * 
 * 2. **HTTP Proxy Testing**: The service handles HTTP request proxying, which we test
 *    by mocking fetch and validating request transformation.
 * 
 * 3. **Port Management Logic**: Tests cover exposing/unexposing ports, validation,
 *    conflict detection, and lifecycle management.
 * 
 * 4. **ServiceResult Pattern**: All business methods return ServiceResult<T>,
 *    enabling consistent testing of success/error scenarios.
 * 
 * 5. **Timer-Based Cleanup**: The service runs automatic cleanup, tested using
 *    Vitest's fake timers to validate interval behavior.
 * 
 * 6. **Request/Response Handling**: Tests validate both Request parsing and Response
 *    generation for proxy functionality.
 * 
 * 7. **Status Management**: Tests cover port status transitions (active → inactive)
 *    and cleanup based on status and timestamps.
 * 
 * 8. **Security Integration**: Validates that port numbers go through security
 *    validation before being used.
 */