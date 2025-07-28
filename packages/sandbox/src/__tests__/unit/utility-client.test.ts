import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UtilityClient } from '../../clients/utility-client';
import type { PingResponse, CommandsResponse, HttpClientOptions } from '../../clients/types';

describe('UtilityClient', () => {
  let client: UtilityClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new UtilityClient({
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
      const defaultClient = new UtilityClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const customClient = new UtilityClient({
        baseUrl: 'http://custom.com',
        port: 8080,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });
  });

  describe('ping', () => {
    const mockResponse: PingResponse = {
      success: true,
      message: 'pong',
      uptime: 12345,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should ping successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.ping();

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/ping', {
        method: 'GET',
      });

      expect(result).toBe('pong');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Ping successful: pong'
      );
    });

    it('should ping successfully with different message', async () => {
      const aliveResponse = { ...mockResponse, message: 'alive' };
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(aliveResponse), { status: 200 })
      );

      const result = await client.ping();

      expect(result).toBe('alive');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Ping successful: alive'
      );
    });

    it('should handle ping timeout error', async () => {
      const errorResponse = {
        error: 'Request timeout',
        code: 'TIMEOUT',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 408 })
      );

      await expect(client.ping()).rejects.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in ping:',
        expect.any(Error)
      );
    });

    it('should handle ping service unavailable error', async () => {
      const errorResponse = {
        error: 'Service unavailable',
        code: 'SERVICE_UNAVAILABLE',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 503 })
      );

      await expect(client.ping()).rejects.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in ping:',
        expect.any(Error)
      );
    });

    it('should handle network errors during ping', async () => {
      const networkError = new Error('Network unreachable');
      fetchMock.mockRejectedValue(networkError);

      await expect(client.ping()).rejects.toThrow('Network unreachable');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in ping:',
        networkError
      );
    });

    it('should handle malformed ping response', async () => {
      fetchMock.mockResolvedValue(
        new Response('invalid json', { status: 200 })
      );

      await expect(client.ping()).rejects.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in ping:',
        expect.any(Error)
      );
    });
  });

  describe('getCommands', () => {
    const mockCommands = ['ls', 'cat', 'echo', 'grep', 'find', 'curl', 'node', 'npm'];
    const mockResponse: CommandsResponse = {
      success: true,
      availableCommands: mockCommands,
      count: 8,
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should get available commands successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/commands', {
        method: 'GET',
      });

      expect(result).toEqual(mockCommands);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Commands retrieved: 8 commands available'
      );
    });

    it('should handle empty commands list', async () => {
      const emptyResponse: CommandsResponse = {
        success: true,
        availableCommands: [],
        count: 0,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(emptyResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual([]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Commands retrieved: 0 commands available'
      );
    });

    it('should handle large commands list', async () => {
      const largeCommandsList = Array.from({ length: 100 }, (_, i) => `command${i}`);
      const largeResponse: CommandsResponse = {
        success: true,
        availableCommands: largeCommandsList,
        count: 100,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(largeResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual(largeCommandsList);
      expect(result).toHaveLength(100);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Commands retrieved: 100 commands available'
      );
    });

    it('should handle get commands internal server error', async () => {
      const errorResponse = {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.getCommands()).rejects.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in getCommands:',
        expect.any(Error)
      );
    });

    it('should handle get commands permission denied error', async () => {
      const errorResponse = {
        error: 'Permission denied',
        code: 'PERMISSION_DENIED',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 403 })
      );

      await expect(client.getCommands()).rejects.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in getCommands:',
        expect.any(Error)
      );
    });

    it('should handle network errors during getCommands', async () => {
      const networkError = new Error('Connection reset');
      fetchMock.mockRejectedValue(networkError);

      await expect(client.getCommands()).rejects.toThrow('Connection reset');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in getCommands:',
        networkError
      );
    });

    it('should handle malformed commands response', async () => {
      fetchMock.mockResolvedValue(
        new Response('invalid json', { status: 200 })
      );

      await expect(client.getCommands()).rejects.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in getCommands:',
        expect.any(Error)
      );
    });
  });

  describe('specialized command lists', () => {
    it('should handle development-focused command list', async () => {
      const devCommands = ['node', 'npm', 'yarn', 'git', 'docker', 'kubectl', 'terraform'];
      const devResponse: CommandsResponse = {
        success: true,
        availableCommands: devCommands,
        count: 7,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(devResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual(devCommands);
      expect(result).toContain('node');
      expect(result).toContain('npm');
      expect(result).toContain('git');
    });

    it('should handle system administration command list', async () => {
      const sysadminCommands = ['ps', 'top', 'netstat', 'systemctl', 'journalctl', 'iptables'];
      const sysadminResponse: CommandsResponse = {
        success: true,
        availableCommands: sysadminCommands,
        count: 6,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(sysadminResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual(sysadminCommands);
      expect(result).toContain('ps');
      expect(result).toContain('systemctl');
    });

    it('should handle basic shell command list', async () => {
      const basicCommands = ['ls', 'cat', 'echo', 'cd', 'pwd', 'mkdir', 'rm', 'cp', 'mv'];
      const basicResponse: CommandsResponse = {
        success: true,
        availableCommands: basicCommands,
        count: 9,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(basicResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual(basicCommands);
      expect(result).toContain('ls');
      expect(result).toContain('cat');
      expect(result).toContain('echo');
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle responses with mismatched count', async () => {
      const mismatchedResponse: CommandsResponse = {
        success: true,
        availableCommands: ['ls', 'cat'],
        count: 5, // Incorrect count
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mismatchedResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual(['ls', 'cat']);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Commands retrieved: 5 commands available'
      );
    });

    it('should handle commands with special characters', async () => {
      const specialCommands = ['gh-cli', 'docker-compose', 'kubectl_v1.21', 'npm@latest'];
      const specialResponse: CommandsResponse = {
        success: true,
        availableCommands: specialCommands,
        count: 4,
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(specialResponse), { status: 200 })
      );

      const result = await client.getCommands();

      expect(result).toEqual(specialCommands);
      expect(result).toContain('gh-cli');
      expect(result).toContain('docker-compose');
      expect(result).toContain('kubectl_v1.21');
      expect(result).toContain('npm@latest');
    });
  });
});