import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExposePortResponse,
  GetExposedPortsResponse,
  UnexposePortResponse
} from '../src/clients';
import { PortClient } from '../src/clients/port-client';
import {
  InvalidPortError,
  PortAlreadyExposedError,
  PortError,
  PortInUseError,
  PortNotExposedError,
  SandboxError,
  ServiceNotRespondingError
} from '../src/errors';

describe('PortClient', () => {
  let client: PortClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new PortClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('service exposure', () => {
    it('should expose web services successfully', async () => {
      const mockResponse: ExposePortResponse = {
        success: true,
        port: 3001,
        exposedAt: 'https://preview-abc123.workers.dev',
        name: 'web-server',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exposePort(3001, 'session-123', 'web-server');

      expect(result.success).toBe(true);
      expect(result.port).toBe(3001);
      expect(result.exposedAt).toBe('https://preview-abc123.workers.dev');
      expect(result.name).toBe('web-server');
      expect(result.exposedAt.startsWith('https://')).toBe(true);
    });

    it('should expose API services on different ports', async () => {
      const mockResponse: ExposePortResponse = {
        success: true,
        port: 8080,
        exposedAt: 'https://api-def456.workers.dev',
        name: 'api-server',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exposePort(8080, 'session-456', 'api-server');

      expect(result.success).toBe(true);
      expect(result.port).toBe(8080);
      expect(result.name).toBe('api-server');
      expect(result.exposedAt).toContain('api-');
    });

    it('should expose services without explicit names', async () => {
      const mockResponse: ExposePortResponse = {
        success: true,
        port: 5000,
        exposedAt: 'https://service-ghi789.workers.dev',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exposePort(5000, 'session-789');

      expect(result.success).toBe(true);
      expect(result.port).toBe(5000);
      expect(result.name).toBeUndefined();
      expect(result.exposedAt).toBeDefined();
    });
  });

  describe('service management', () => {
    it('should list all exposed services', async () => {
      const mockResponse: GetExposedPortsResponse = {
        success: true,
        ports: [
          {
            port: 3000,
            exposedAt: 'https://frontend-abc123.workers.dev',
            name: 'frontend'
          },
          {
            port: 4000,
            exposedAt: 'https://api-def456.workers.dev',
            name: 'api'
          },
          {
            port: 5432,
            exposedAt: 'https://db-ghi789.workers.dev',
            name: 'database'
          }
        ],
        count: 3,
        timestamp: '2023-01-01T00:10:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getExposedPorts('session-list');

      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
      expect(result.ports).toHaveLength(3);

      result.ports.forEach((service) => {
        expect(service.exposedAt).toContain('.workers.dev');
        expect(service.port).toBeGreaterThan(0);
        expect(service.name).toBeDefined();
      });
    });

    it('should handle empty exposed ports list', async () => {
      const mockResponse: GetExposedPortsResponse = {
        success: true,
        ports: [],
        count: 0,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getExposedPorts('session-empty');

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.ports).toHaveLength(0);
    });

    it('should unexpose services cleanly', async () => {
      const mockResponse: UnexposePortResponse = {
        success: true,
        port: 3001,
        timestamp: '2023-01-01T00:15:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.unexposePort(3001, 'session-unexpose');

      expect(result.success).toBe(true);
      expect(result.port).toBe(3001);
    });
  });

  describe('port validation and error handling', () => {
    it('should handle port already exposed errors', async () => {
      const errorResponse = {
        error: 'Port already exposed: 3000',
        code: 'PORT_ALREADY_EXPOSED'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(client.exposePort(3000, 'session-err')).rejects.toThrow(
        PortAlreadyExposedError
      );
    });

    it('should handle invalid port numbers', async () => {
      const errorResponse = {
        error: 'Invalid port number: 0',
        code: 'INVALID_PORT_NUMBER'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(client.exposePort(0, 'session-err')).rejects.toThrow(
        InvalidPortError
      );
    });

    it('should handle port in use errors', async () => {
      const errorResponse = {
        error: 'Port in use: 3000 is already bound by another process',
        code: 'PORT_IN_USE'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(client.exposePort(3000, 'session-err')).rejects.toThrow(
        PortInUseError
      );
    });

    it('should handle service not responding errors', async () => {
      const errorResponse = {
        error: 'Service not responding on port 8080',
        code: 'SERVICE_NOT_RESPONDING'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 503 })
      );

      await expect(client.exposePort(8080, 'session-err')).rejects.toThrow(
        ServiceNotRespondingError
      );
    });

    it('should handle unexpose non-existent port', async () => {
      const errorResponse = {
        error: 'Port not exposed: 9999',
        code: 'PORT_NOT_EXPOSED'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.unexposePort(9999, 'session-err')).rejects.toThrow(
        PortNotExposedError
      );
    });

    it('should handle port operation failures', async () => {
      const errorResponse = {
        error: 'Port operation failed: unable to setup proxy',
        code: 'PORT_OPERATION_ERROR'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.exposePort(3000, 'session-err')).rejects.toThrow(
        PortError
      );
    });
  });

  describe('edge cases and resilience', () => {
    it('should handle network failures gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(client.exposePort(3000, 'session-net')).rejects.toThrow(
        'Network connection failed'
      );
    });

    it('should handle malformed server responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', { status: 200 })
      );

      await expect(client.exposePort(3000, 'session-malform')).rejects.toThrow(
        SandboxError
      );
    });
  });
});
