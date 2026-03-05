import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { Logger } from '@repo/shared';
import type {
  PortInfo,
  PortNotFoundResponse,
  ProxyErrorResponse
} from '@sandbox-container/core/types';
import {
  PortService,
  type PortStore,
  type SecurityService
} from '@sandbox-container/services/port-service';
import { mocked } from '../test-utils';

// Properly typed mock dependencies
const mockPortStore: PortStore = {
  expose: vi.fn(),
  unexpose: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn()
};

const mockSecurityService: SecurityService = {
  validatePort: vi.fn()
};

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn()
} as Logger;
mockLogger.child = vi.fn(() => mockLogger);

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
    global.fetch = mockFetch as unknown as typeof fetch;

    // Set up default successful security validation
    mocked(mockSecurityService.validatePort).mockReturnValue({
      isValid: true,
      errors: []
    });

    portService = new PortService(
      mockPortStore,
      mockSecurityService,
      mockLogger
    );
  });

  afterEach(() => {
    // Clean up timers and destroy service
    if (portService) {
      portService.destroy();
    }

    // Restore original fetch to prevent test interference
    global.fetch = originalFetch;
  });

  describe('exposePort', () => {
    it('should expose port successfully with valid port number', async () => {
      mocked(mockPortStore.get).mockResolvedValue(null);

      const result = await portService.exposePort(8080, 'web-server');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.port).toBe(8080);
        expect(result.data.status).toBe('active');
      }

      expect(mockSecurityService.validatePort).toHaveBeenCalledWith(8080);
      expect(mockPortStore.expose).toHaveBeenCalledWith(
        8080,
        expect.any(Object)
      );
    });

    it('should return error when port validation fails', async () => {
      mocked(mockSecurityService.validatePort).mockReturnValue({
        isValid: false,
        errors: ['Port must be between 1024-65535', 'Port 80 is reserved']
      });

      const result = await portService.exposePort(80);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_PORT_NUMBER');
        expect(result.error.message).toContain(
          'Port must be between 1024-65535'
        );
        expect(result.error.details?.port).toBe(80);
        expect(result.error.details?.reason).toContain(
          'Port must be between 1024-65535'
        );
      }

      // Should not attempt to store port
      expect(mockPortStore.expose).not.toHaveBeenCalled();
    });

    it('should return error when port is already exposed', async () => {
      const existingPortInfo: PortInfo = {
        port: 8080,
        name: 'existing-service',
        exposedAt: new Date(),
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(existingPortInfo);

      const result = await portService.exposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_ALREADY_EXPOSED');
        expect(result.error.message).toContain('Port 8080');
        expect(result.error.details?.portName).toBe('existing-service');
      }

      // Should not attempt to expose again
      expect(mockPortStore.expose).not.toHaveBeenCalled();
    });

    it('should handle store errors gracefully', async () => {
      mocked(mockPortStore.get).mockResolvedValue(null);
      const storeError = new Error('Store connection failed');
      mocked(mockPortStore.expose).mockRejectedValue(storeError);

      const result = await portService.exposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_OPERATION_ERROR');
        expect(result.error.details?.stderr).toBe('Store connection failed');
      }
    });
  });

  describe('unexposePort', () => {
    it('should unexpose port successfully when port is exposed', async () => {
      const existingPortInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(existingPortInfo);

      const result = await portService.unexposePort(8080);

      expect(result.success).toBe(true);
      expect(mockPortStore.unexpose).toHaveBeenCalledWith(8080);
    });

    it('should return error when port is not exposed', async () => {
      mocked(mockPortStore.get).mockResolvedValue(null);

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
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(existingPortInfo);
      const storeError = new Error('Unexpose failed');
      mocked(mockPortStore.unexpose).mockRejectedValue(storeError);

      const result = await portService.unexposePort(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_OPERATION_ERROR');
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
            status: 'active' as const
          }
        }
      ];
      mocked(mockPortStore.list).mockResolvedValue(mockPorts);

      const result = await portService.getExposedPorts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].port).toBe(8080);
      }
    });

    it('should handle store list errors', async () => {
      const listError = new Error('Store list failed');
      mocked(mockPortStore.list).mockRejectedValue(listError);

      const result = await portService.getExposedPorts();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_OPERATION_ERROR');
      }
    });
  });

  describe('getPortInfo', () => {
    it('should return port info when port is exposed', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(portInfo);

      const result = await portService.getPortInfo(8080);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(portInfo);
      }
    });

    it('should return error when port is not found', async () => {
      mocked(mockPortStore.get).mockResolvedValue(null);

      const result = await portService.getPortInfo(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_NOT_EXPOSED');
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
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(portInfo);

      const mockResponse = new Response('Hello World', { status: 200 });
      mockFetch.mockResolvedValue(mockResponse);

      const testRequest = new Request(
        'http://example.com/proxy/8080/api/test?param=value'
      );

      const response = await portService.proxyRequest(8080, testRequest);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Hello World');

      const fetchCall = mockFetch.mock.calls[0][0] as Request;
      expect(fetchCall.url).toBe('http://localhost:8080/api/test?param=value');
    });

    it('should return 404 when port is not exposed', async () => {
      mocked(mockPortStore.get).mockResolvedValue(null);

      const testRequest = new Request('http://example.com/proxy/8080/api/test');
      const response = await portService.proxyRequest(8080, testRequest);

      expect(response.status).toBe(404);
      const responseData = (await response.json()) as PortNotFoundResponse;
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
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(portInfo);

      const fetchError = new Error('Connection refused');
      mockFetch.mockRejectedValue(fetchError);

      const testRequest = new Request('http://example.com/proxy/8080/api/test');
      const response = await portService.proxyRequest(8080, testRequest);

      expect(response.status).toBe(502);
      const responseData = (await response.json()) as ProxyErrorResponse;
      expect(responseData.error).toBe('Proxy error');
      expect(responseData.message).toContain('Connection refused');
    });
  });

  describe('markPortInactive', () => {
    it('should mark port as inactive successfully', async () => {
      const portInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date(),
        status: 'active'
      };
      mocked(mockPortStore.get).mockResolvedValue(portInfo);
      mocked(mockPortStore.expose).mockResolvedValue(undefined);

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
    });

    it('should return error when port is not found', async () => {
      mocked(mockPortStore.get).mockResolvedValue(null);

      const result = await portService.markPortInactive(8080);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_NOT_EXPOSED');
      }

      // Should not attempt to update
      expect(mockPortStore.expose).not.toHaveBeenCalled();
    });
  });

  describe('cleanupInactivePorts', () => {
    it('should cleanup inactive ports and return count', async () => {
      mocked(mockPortStore.cleanup).mockResolvedValue(3);

      const result = await portService.cleanupInactivePorts();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(3);
      }

      // Verify cleanup was called with 1 hour ago threshold
      expect(mockPortStore.cleanup).toHaveBeenCalledWith(expect.any(Date));
    });

    it('should handle cleanup errors', async () => {
      const cleanupError = new Error('Cleanup failed');
      mocked(mockPortStore.cleanup).mockRejectedValue(cleanupError);

      const result = await portService.cleanupInactivePorts();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PORT_OPERATION_ERROR');
      }
    });
  });
});
