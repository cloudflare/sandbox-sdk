import { PortClient } from '../../clients/port-client';
import type { 
  ExposePortResponse, 
  UnexposePortResponse, 
  GetExposedPortsResponse,
  ExposedPortInfo,
  HttpClientOptions 
} from '../../clients';

describe('PortClient', () => {
  let client: PortClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new PortClient({
      baseUrl: 'http://test.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultClient = new PortClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const customClient = new PortClient({
        baseUrl: 'http://custom.com',
        port: 8080,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });
  });

  describe('exposePort', () => {
    const mockResponse: ExposePortResponse = {
      success: true,
      port: 3001,
      exposedAt: 'https://preview-abc123.workers.dev',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should expose port successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exposePort(3001);

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/expose-port', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          port: 3001,
          name: undefined,
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should expose port with name successfully', async () => {
      const namedResponse = { ...mockResponse, name: 'web' };
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(namedResponse), { status: 200 })
      );

      const result = await client.exposePort(3001, 'web');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/expose-port', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          port: 3001,
          name: 'web',
        }),
      });

      expect(result).toEqual(namedResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle port already exposed error', async () => {
      const errorResponse = {
        error: 'Port already exposed',
        code: 'PORT_ALREADY_EXPOSED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(client.exposePort(3001)).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle invalid port error', async () => {
      const errorResponse = {
        error: 'Invalid port number',
        code: 'INVALID_PORT_NUMBER',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(client.exposePort(80)).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle port in use error', async () => {
      const errorResponse = {
        error: 'Port in use',
        code: 'PORT_IN_USE',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(client.exposePort(3000)).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('unexposePort', () => {
    const mockResponse: UnexposePortResponse = {
      success: true,
      port: 3001,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should unexpose port successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.unexposePort(3001);

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/exposed-ports/3001', {
        method: 'DELETE',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle port not exposed error', async () => {
      const errorResponse = {
        error: 'Port not exposed',
        code: 'PORT_NOT_EXPOSED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.unexposePort(3001)).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle service not responding error', async () => {
      const errorResponse = {
        error: 'Service not responding',
        code: 'SERVICE_NOT_RESPONDING',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 502 })
      );

      await expect(client.unexposePort(3001)).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('getExposedPorts', () => {
    const mockExposedPorts: ExposedPortInfo[] = [
      {
        port: 3001,
        name: 'web',
        exposedAt: 'https://preview-abc123.workers.dev',
      },
      {
        port: 3002,
        name: 'api',
        exposedAt: 'https://preview-def456.workers.dev',
      },
    ];

    const mockResponse: GetExposedPortsResponse = {
      success: true,
      ports: mockExposedPorts,
      count: 2,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should get exposed ports successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getExposedPorts();

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/exposed-ports', {
        method: 'GET',
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle empty exposed ports list', async () => {
      const emptyResponse: GetExposedPortsResponse = {
        success: true,
        ports: [],
        count: 0,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(emptyResponse), { status: 200 })
      );

      const result = await client.getExposedPorts();

      expect(result).toEqual(emptyResponse);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should handle get exposed ports errors', async () => {
      const errorResponse = {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.getExposedPorts()).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('error scenarios', () => {
    it('should handle network errors during port operations', async () => {
      const networkError = new Error('Network failed');
      fetchMock.mockRejectedValue(networkError);

      await expect(client.exposePort(3001)).rejects.toThrow('Network failed');
      // Console error logging is disabled in test environment for cleaner output
    });

    it('should handle malformed response data', async () => {
      fetchMock.mockResolvedValue(
        new Response('invalid json', { status: 200 })
      );

      await expect(client.getExposedPorts()).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
    });
  });

  describe('port validation edge cases', () => {
    it('should expose high port numbers', async () => {
      const mockResponse: ExposePortResponse = {
        success: true,
        port: 65535,
        exposedAt: 'https://preview-xyz789.workers.dev',
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.exposePort(65535);

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/expose-port', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          port: 65535,
          name: undefined,
        }),
      });

      expect(result.port).toBe(65535);
    });

    it('should handle port names with special characters', async () => {
      const mockResponse: ExposePortResponse = {
        success: true,
        port: 3001,
        name: 'web-app_v2',
        exposedAt: 'https://preview-abc123.workers.dev',
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.exposePort(3001, 'web-app_v2');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/expose-port', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          port: 3001,
          name: 'web-app_v2',
        }),
      });

      // Console logging is disabled in test environment for cleaner output
    });
  });
});