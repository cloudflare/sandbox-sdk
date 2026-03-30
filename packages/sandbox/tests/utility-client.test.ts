import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommandsResponse,
  PingResponse,
  VersionResponse
} from '../src/clients';
import { UtilityClient } from '../src/clients/utility-client';
import { SandboxError } from '../src/errors';

// Mock data factory for creating test responses
const mockPingResponse = (
  overrides: Partial<PingResponse> = {}
): PingResponse => ({
  success: true,
  message: 'pong',
  uptime: 12345,
  timestamp: '2023-01-01T00:00:00Z',
  ...overrides
});

const mockCommandsResponse = (
  commands: string[],
  overrides: Partial<CommandsResponse> = {}
): CommandsResponse => ({
  success: true,
  availableCommands: commands,
  count: commands.length,
  timestamp: '2023-01-01T00:00:00Z',
  ...overrides
});

const mockVersionResponse = (
  version: string = '0.4.5',
  overrides: Partial<VersionResponse> = {}
): VersionResponse => ({
  success: true,
  version,
  timestamp: '2023-01-01T00:00:00Z',
  ...overrides
});

describe('UtilityClient', () => {
  let client: UtilityClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new UtilityClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('health checking', () => {
    it('should check sandbox health successfully', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockPingResponse()), { status: 200 })
      );

      const result = await client.ping();

      expect(result).toBe('pong');
    });

    it('should handle different health messages', async () => {
      const messages = ['pong', 'alive', 'ok'];

      for (const message of messages) {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(mockPingResponse({ message })), {
            status: 200
          })
        );

        const result = await client.ping();
        expect(result).toBe(message);
      }
    });

    it('should handle concurrent health checks', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(mockPingResponse())))
      );

      const healthChecks = await Promise.all([
        client.ping(),
        client.ping(),
        client.ping()
      ]);

      expect(healthChecks).toHaveLength(3);
      healthChecks.forEach((result) => {
        expect(result).toBe('pong');
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should detect unhealthy sandbox conditions', async () => {
      const errorResponse = {
        error: 'Service Unavailable',
        code: 'HEALTH_CHECK_FAILED'
      };

      // Use 500 for permanent errors (503 triggers retry)
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.ping()).rejects.toThrow();
    });

    it('should handle network failures during health checks', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(client.ping()).rejects.toThrow('Network connection failed');
    });
  });

  describe('command discovery', () => {
    it('should discover available system commands', async () => {
      const systemCommands = ['ls', 'cat', 'echo', 'grep', 'find'];

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockCommandsResponse(systemCommands)), {
          status: 200
        })
      );

      const result = await client.getCommands();

      expect(result).toEqual(systemCommands);
      expect(result).toContain('ls');
      expect(result).toContain('grep');
      expect(result).toHaveLength(systemCommands.length);
    });

    it('should handle minimal command environments', async () => {
      const minimalCommands = ['sh', 'echo', 'cat'];

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockCommandsResponse(minimalCommands)), {
          status: 200
        })
      );

      const result = await client.getCommands();

      expect(result).toEqual(minimalCommands);
      expect(result).toHaveLength(3);
    });

    it('should handle large command environments', async () => {
      const richCommands = Array.from({ length: 150 }, (_, i) => `cmd_${i}`);

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockCommandsResponse(richCommands)), {
          status: 200
        })
      );

      const result = await client.getCommands();

      expect(result).toEqual(richCommands);
      expect(result).toHaveLength(150);
    });

    it('should handle empty command environments', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockCommandsResponse([])), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('should handle command discovery failures', async () => {
      const errorResponse = {
        error: 'Access denied to command list',
        code: 'PERMISSION_DENIED'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 403 })
      );

      await expect(client.getCommands()).rejects.toThrow();
    });
  });

  describe('error handling and resilience', () => {
    it('should handle malformed server responses gracefully', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', { status: 200 })
      );

      await expect(client.ping()).rejects.toThrow(SandboxError);
    });

    it('should handle network timeouts and connectivity issues', async () => {
      const networkError = new Error('Network timeout');
      mockFetch.mockRejectedValue(networkError);

      await expect(client.ping()).rejects.toThrow(networkError.message);
    });

    it('should handle partial service failures', async () => {
      // First call (ping) succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockPingResponse()), { status: 200 })
      );

      // Second call (getCommands) fails with permanent error
      // Use 500 for permanent errors (503 triggers retry)
      const errorResponse = {
        error: 'Command enumeration service unavailable',
        code: 'SERVICE_UNAVAILABLE'
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      const pingResult = await client.ping();
      expect(pingResult).toBe('pong');

      await expect(client.getCommands()).rejects.toThrow();
    });

    it('should handle concurrent operations with mixed success', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount % 2 === 0) {
          return Promise.reject(new Error('Intermittent failure'));
        } else {
          return Promise.resolve(
            new Response(JSON.stringify(mockPingResponse()))
          );
        }
      });

      const results = await Promise.allSettled([
        client.ping(), // Should succeed (call 1)
        client.ping(), // Should fail (call 2)
        client.ping(), // Should succeed (call 3)
        client.ping() // Should fail (call 4)
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
      expect(results[3].status).toBe('rejected');
    });
  });

  describe('version checking', () => {
    it('should get container version successfully', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockVersionResponse('0.4.5')), {
          status: 200
        })
      );

      const result = await client.getVersion();

      expect(result).toBe('0.4.5');
    });

    it('should handle different version formats', async () => {
      const versions = ['1.0.0', '2.5.3-beta', '0.0.1', '10.20.30'];

      for (const version of versions) {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(mockVersionResponse(version)), {
            status: 200
          })
        );

        const result = await client.getVersion();
        expect(result).toBe(version);
      }
    });

    it('should return "unknown" when version endpoint does not exist (backward compatibility)', async () => {
      // Simulate 404 or other error for old containers
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 })
      );

      const result = await client.getVersion();

      expect(result).toBe('unknown');
    });

    it('should return "unknown" on network failure (backward compatibility)', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      const result = await client.getVersion();

      expect(result).toBe('unknown');
    });

    it('should handle version response with unknown value', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockVersionResponse('unknown')), {
          status: 200
        })
      );

      const result = await client.getVersion();

      expect(result).toBe('unknown');
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new UtilityClient();
      expect(minimalClient).toBeInstanceOf(UtilityClient);
    });

    it('should initialize with full options', () => {
      const fullOptionsClient = new UtilityClient({
        baseUrl: 'http://custom.com',
        port: 8080
      });
      expect(fullOptionsClient).toBeInstanceOf(UtilityClient);
    });
  });
});
