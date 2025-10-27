import type { DurableObjectState } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../src/sandbox';

// Mock Container before imports - same pattern as sandbox.test.ts
vi.mock('@cloudflare/containers', () => ({
  Container: class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    // Minimal fetch implementation that will be spied on
    async fetch(_request: Request): Promise<Response> {
      return new Response('Not implemented');
    }
  },
  getContainer: vi.fn(),
}));

/**
 * Tests for Sandbox.connect() method
 *
 * This test suite validates that sandbox.connect() properly calls super.fetch()
 * (Container.fetch) with the correct WebSocket upgrade request.
 */
describe('Sandbox.connect() - WebSocket connection method', () => {
  let sandbox: Sandbox;
  let capturedRequest: Request | null = null;
  let fetchSpy: any;

  beforeEach(async () => {
    // Create minimal mock DurableObjectState - same pattern as sandbox.test.ts
    const mockCtx: Partial<DurableObjectState> = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map()),
      } as any,
      blockConcurrencyWhile: vi.fn((fn: () => Promise<void>) => fn()),
      id: {
        toString: () => 'test-connect-sandbox',
        equals: vi.fn(),
        name: 'test-connect',
      } as any,
    };

    const mockEnv = {};

    // Create real Sandbox instance
    sandbox = new Sandbox(mockCtx as DurableObjectState, mockEnv);

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 10));

    // Spy on the sandbox's parent fetch to verify connect() calls super.fetch()
    fetchSpy = vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(sandbox)), 'fetch')
      .mockImplementation(async function(request: RequestInfo | Request) {
        if (request instanceof Request) {
          capturedRequest = request;
        }
        // Return mock response
        return new Response(null, {
          status: 200,
          headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
          },
        });
      });
  });

  afterEach(() => {
    capturedRequest = null;
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
  });

  describe('URL construction', () => {
    it('should construct correct URL for port number and call super.fetch()', async () => {
      await sandbox.connect(3001);

      // Verify super.fetch() was called
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe('http://localhost:3001/');
      expect(capturedRequest!.headers.get('Upgrade')).toBe('websocket');
      expect(capturedRequest!.headers.get('Connection')).toBe('Upgrade');
    });

    it('should construct correct URL for path string and call super.fetch()', async () => {
      await sandbox.connect('/ws/chat');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe('http://localhost:3000/ws/chat');
      expect(capturedRequest!.headers.get('Upgrade')).toBe('websocket');
      expect(capturedRequest!.headers.get('Connection')).toBe('Upgrade');
    });

    it('should throw error for invalid portOrUrl (not a number or path)', async () => {
      await expect(sandbox.connect('invalid-url' as any)).rejects.toThrow(
        'Invalid portOrUrl: must be a port number or path starting with "/"'
      );

      // Should not call super.fetch() if validation fails
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should throw error for empty string', async () => {
      await expect(sandbox.connect('')).rejects.toThrow(
        'Invalid portOrUrl: must be a port number or path starting with "/"'
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should throw error for relative path without leading slash', async () => {
      await expect(sandbox.connect('ws/chat')).rejects.toThrow(
        'Invalid portOrUrl: must be a port number or path starting with "/"'
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Request headers', () => {
    it('should include WebSocket upgrade headers', async () => {
      await sandbox.connect(3001);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.headers.get('Upgrade')).toBe('websocket');
      expect(capturedRequest!.headers.get('Connection')).toBe('Upgrade');
    });

    it('should include custom headers alongside WebSocket headers', async () => {
      await sandbox.connect(3001, {
        headers: {
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'value',
        },
      });

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.headers.get('Upgrade')).toBe('websocket');
      expect(capturedRequest!.headers.get('Connection')).toBe('Upgrade');
      expect(capturedRequest!.headers.get('Authorization')).toBe('Bearer token123');
      expect(capturedRequest!.headers.get('X-Custom-Header')).toBe('value');
    });

    it('should allow custom headers to override defaults (spread operator behavior)', async () => {
      await sandbox.connect(3001, {
        headers: {
          'Upgrade': 'custom-protocol',
        },
      });

      expect(capturedRequest).not.toBeNull();
      // Since options?.headers comes after the defaults in spread,
      // custom header overrides the default
      expect(capturedRequest!.headers.get('Upgrade')).toBe('custom-protocol');
    });
  });

  describe('RequestInit options', () => {
    it('should pass through method option', async () => {
      await sandbox.connect(3001, {
        method: 'GET',
      });

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe('GET');
    });

    it('should pass through multiple options', async () => {
      await sandbox.connect(3001, {
        method: 'GET',
        headers: {
          'User-Agent': 'test-client',
        },
      });

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.method).toBe('GET');
      expect(capturedRequest!.headers.get('User-Agent')).toBe('test-client');
    });

    it('should work with no options provided', async () => {
      await sandbox.connect(3001);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe('http://localhost:3001/');
      expect(capturedRequest!.headers.get('Upgrade')).toBe('websocket');
    });
  });

  describe('Port and path variations', () => {
    it('should handle different port numbers correctly', async () => {
      const testCases = [
        { port: 3000, expected: 'http://localhost:3000/' },
        { port: 3001, expected: 'http://localhost:3001/' },
        { port: 8080, expected: 'http://localhost:8080/' },
        { port: 8888, expected: 'http://localhost:8888/' },
      ];

      for (const { port, expected } of testCases) {
        capturedRequest = null;
        await sandbox.connect(port);
        expect(capturedRequest).not.toBeNull();
        expect(capturedRequest!.url).toBe(expected);
      }
    });

    it('should handle different path formats correctly', async () => {
      const testCases = [
        { path: '/ws', expected: 'http://localhost:3000/ws' },
        { path: '/ws/chat', expected: 'http://localhost:3000/ws/chat' },
        { path: '/api/v1/websocket', expected: 'http://localhost:3000/api/v1/websocket' },
        { path: '/socket.io', expected: 'http://localhost:3000/socket.io' },
      ];

      for (const { path, expected } of testCases) {
        capturedRequest = null;
        await sandbox.connect(path);
        expect(capturedRequest).not.toBeNull();
        expect(capturedRequest!.url).toBe(expected);
      }
    });

    it('should use defaultPort (3000) for path-based connections', async () => {
      await sandbox.connect('/ws/test');

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe('http://localhost:3000/ws/test');
    });
  });
});
