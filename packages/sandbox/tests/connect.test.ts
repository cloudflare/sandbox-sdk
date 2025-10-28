import type { DurableObjectState } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, Sandbox } from '../src/sandbox';

// Mock @cloudflare/containers before importing
vi.mock('@cloudflare/containers', () => {
  const mockSwitchPort = vi.fn((request: Request, port: number) => {
    // Create a new request with the port in the URL path
    const url = new URL(request.url);
    url.pathname = `/proxy/${port}${url.pathname}`;
    return new Request(url, request);
  });

  const MockContainer = class Container {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      // Mock WebSocket upgrade response
      // Note: In Workers runtime, WebSocket upgrades don't return status 101
      // Instead, the runtime handles the upgrade internally
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return new Response('WebSocket Upgraded', {
          status: 200,
          headers: {
            'X-WebSocket-Upgraded': 'true',
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
          },
        });
      }
      return new Response('Mock fetch');
    }
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: mockSwitchPort,
  };
});

describe('connect() - WebSocket Routing', () => {
  let sandbox: Sandbox;
  let mockCtx: Partial<DurableObjectState>;
  let mockEnv: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock DurableObjectState
    mockCtx = {
      storage: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue(new Map()),
      } as any,
      blockConcurrencyWhile: vi.fn(<T>(fn: () => Promise<T>) => fn()),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox',
      } as any,
    };

    mockEnv = {};

    // Create Sandbox instance
    sandbox = new Sandbox(mockCtx as DurableObjectState, mockEnv);

    // Wait for initialization
    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });
  });

  describe('basic functionality', () => {
    it('should route WebSocket request to specified port', async () => {
      // Create a WebSocket upgrade request (RFC 6455 compliant)
      const request = new Request('http://localhost/ws/echo', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });

      // Spy on sandbox.fetch to verify it's called
      const fetchSpy = vi.spyOn(sandbox, 'fetch');

      // Call connect()
      const response = await connect(sandbox, request, 8080);

      // Verify sandbox.fetch was called
      expect(fetchSpy).toHaveBeenCalledOnce();

      // Verify response indicates WebSocket upgrade
      expect(response.status).toBe(200);
      expect(response.headers.get('X-WebSocket-Upgraded')).toBe('true');
      expect(response.headers.get('Upgrade')).toBe('websocket');
    });

    it('should pass port number through switchPort', async () => {
      const request = new Request('http://localhost/ws/terminal', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
        },
      });

      const { switchPort } = await import('@cloudflare/containers');
      const switchPortMock = vi.mocked(switchPort);

      await connect(sandbox, request, 8082);

      // Verify switchPort was called with correct port
      expect(switchPortMock).toHaveBeenCalledWith(request, 8082);
    });

    it('should preserve request headers when routing', async () => {
      const request = new Request('http://localhost/ws/code', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'X-Sandbox-Id': 'test-sandbox-123',
          'X-Custom-Header': 'custom-value',
        },
      });

      const fetchSpy = vi.spyOn(sandbox, 'fetch');

      await connect(sandbox, request, 8081);

      // Get the request that was passed to fetch
      const calledRequest = fetchSpy.mock.calls[0][0];

      // Verify headers are preserved
      expect(calledRequest.headers.get('Upgrade')).toBe('websocket');
      expect(calledRequest.headers.get('X-Sandbox-Id')).toBe('test-sandbox-123');
      expect(calledRequest.headers.get('X-Custom-Header')).toBe('custom-value');
    });
  });

  describe('port routing', () => {
    it('should route to port 8080 for echo server', async () => {
      const request = new Request('http://localhost/ws/echo', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const { switchPort } = await import('@cloudflare/containers');
      const switchPortMock = vi.mocked(switchPort);

      await connect(sandbox, request, 8080);

      expect(switchPortMock).toHaveBeenCalledWith(request, 8080);
    });

    it('should route to port 8081 for code server', async () => {
      const request = new Request('http://localhost/ws/code', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const { switchPort } = await import('@cloudflare/containers');
      const switchPortMock = vi.mocked(switchPort);

      await connect(sandbox, request, 8081);

      expect(switchPortMock).toHaveBeenCalledWith(request, 8081);
    });

    it('should route to port 8082 for terminal server', async () => {
      const request = new Request('http://localhost/ws/terminal', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const { switchPort } = await import('@cloudflare/containers');
      const switchPortMock = vi.mocked(switchPort);

      await connect(sandbox, request, 8082);

      expect(switchPortMock).toHaveBeenCalledWith(request, 8082);
    });

    it('should support custom ports', async () => {
      const request = new Request('http://localhost/ws/custom', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const { switchPort } = await import('@cloudflare/containers');
      const switchPortMock = vi.mocked(switchPort);

      await connect(sandbox, request, 9000);

      expect(switchPortMock).toHaveBeenCalledWith(request, 9000);
    });
  });

  describe('error handling', () => {
    it('should propagate errors from sandbox.fetch', async () => {
      const request = new Request('http://localhost/ws/error', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      // Mock fetch to throw an error
      vi.spyOn(sandbox, 'fetch').mockRejectedValueOnce(
        new Error('Container connection failed')
      );

      await expect(connect(sandbox, request, 8080)).rejects.toThrow(
        'Container connection failed'
      );
    });

    it('should reject invalid port numbers', async () => {
      const request = new Request('http://localhost/ws/test', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      // Test with negative port
      await expect(connect(sandbox, request, -1)).rejects.toThrow('Invalid or restricted port');

      // Test with port 0
      await expect(connect(sandbox, request, 0)).rejects.toThrow('Invalid or restricted port');

      // Test with port > 65535
      await expect(connect(sandbox, request, 70000)).rejects.toThrow('Invalid or restricted port');
    });

    it('should reject privileged ports (< 1024)', async () => {
      const request = new Request('http://localhost/ws/test', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      // Test with port 80 (privileged)
      await expect(connect(sandbox, request, 80)).rejects.toThrow('Invalid or restricted port');

      // Test with port 443 (privileged)
      await expect(connect(sandbox, request, 443)).rejects.toThrow('Invalid or restricted port');

      // Test with port 22 (privileged)
      await expect(connect(sandbox, request, 22)).rejects.toThrow('Invalid or restricted port');
    });

    it('should allow valid user ports (1024-65535)', async () => {
      const request = new Request('http://localhost/ws/test', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      // Test boundary: port 1024 (first valid user port)
      await expect(connect(sandbox, request, 1024)).resolves.toBeDefined();

      // Test boundary: port 65535 (last valid port)
      await expect(connect(sandbox, request, 65535)).resolves.toBeDefined();

      // Test common ports
      await expect(connect(sandbox, request, 8080)).resolves.toBeDefined();
      await expect(connect(sandbox, request, 3001)).resolves.toBeDefined();
    });
  });

  describe('WebSocket upgrade scenarios', () => {
    it('should handle standard WebSocket headers', async () => {
      const request = new Request('http://localhost/ws/test', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Protocol': 'chat',
        },
      });

      const response = await connect(sandbox, request, 8080);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-WebSocket-Upgraded')).toBe('true');
    });

    it('should handle WebSocket with query parameters', async () => {
      const request = new Request('http://localhost/ws/test?token=abc123&room=lobby', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const fetchSpy = vi.spyOn(sandbox, 'fetch');

      await connect(sandbox, request, 8080);

      const calledRequest = fetchSpy.mock.calls[0][0];
      const url = new URL(calledRequest.url);

      // Verify query parameters are preserved
      expect(url.searchParams.get('token')).toBe('abc123');
      expect(url.searchParams.get('room')).toBe('lobby');
    });

    it('should handle WebSocket with path segments', async () => {
      const request = new Request('http://localhost/ws/rooms/123/chat', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const fetchSpy = vi.spyOn(sandbox, 'fetch');

      await connect(sandbox, request, 8080);

      const calledRequest = fetchSpy.mock.calls[0][0];
      const url = new URL(calledRequest.url);

      // Verify path is preserved in proxied request
      expect(url.pathname).toContain('rooms/123/chat');
    });

    it('should handle case-insensitive Upgrade header', async () => {
      const request = new Request('http://localhost/ws/test', {
        headers: {
          'Upgrade': 'WebSocket', // Mixed case
          'Connection': 'upgrade',
        },
      });

      const response = await connect(sandbox, request, 8080);

      // Should still work with non-lowercase Upgrade header
      expect(response.status).toBe(200);
      expect(response.headers.get('X-WebSocket-Upgraded')).toBe('true');
    });
  });

  describe('integration with Sandbox', () => {
    it('should work with getSandbox helper', async () => {
      // This tests the typical usage pattern
      const { getSandbox } = await import('../src/sandbox');
      const { getContainer } = await import('@cloudflare/containers');

      const mockNamespace = {} as any;
      const getContainerMock = vi.mocked(getContainer);
      getContainerMock.mockReturnValue(sandbox as any);

      const sandboxStub = getSandbox(mockNamespace, 'test-id');

      const request = new Request('http://localhost/ws/echo', {
        headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
      });

      const response = await connect(sandboxStub, request, 8080);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-WebSocket-Upgraded')).toBe('true');
    });
  });
});
