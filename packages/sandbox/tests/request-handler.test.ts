import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyToSandbox, type SandboxEnv } from '../src/request-handler';
import type { Sandbox } from '../src/sandbox';

// Mock getSandbox from sandbox.ts
vi.mock('../src/sandbox', () => {
  const mockFn = vi.fn();
  return {
    getSandbox: mockFn,
    Sandbox: vi.fn()
  };
});

// Import the mock after vi.mock is set up
import { getSandbox } from '../src/sandbox';

describe('proxyToSandbox - WebSocket Support', () => {
  let mockSandbox: Partial<Sandbox>;
  let mockEnv: SandboxEnv;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Sandbox with necessary methods
    mockSandbox = {
      validatePortToken: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(new Response('WebSocket response')),
      containerFetch: vi.fn().mockResolvedValue(new Response('HTTP response'))
    };

    mockEnv = {
      Sandbox: {} as any
    };

    vi.mocked(getSandbox).mockReturnValue(mockSandbox as Sandbox);
  });

  describe('WebSocket detection and routing', () => {
    it('should detect WebSocket upgrade header (case-insensitive)', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/ws',
        {
          headers: {
            Upgrade: 'websocket',
            Connection: 'Upgrade'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      // Should route through fetch() for WebSocket
      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });

    it('should set cf-container-target-port header for WebSocket', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/ws',
        {
          headers: {
            Upgrade: 'websocket'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      const fetchCall = vi.mocked(mockSandbox.fetch as any).mock
        .calls[0][0] as Request;
      expect(fetchCall.headers.get('cf-container-target-port')).toBe('8080');
    });

    it('should preserve original headers for WebSocket', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/ws',
        {
          headers: {
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': 'test-key-123',
            'Sec-WebSocket-Version': '13',
            'User-Agent': 'test-client'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      const fetchCall = vi.mocked(mockSandbox.fetch as any).mock
        .calls[0][0] as Request;
      expect(fetchCall.headers.get('Upgrade')).toBe('websocket');
      expect(fetchCall.headers.get('Sec-WebSocket-Key')).toBe('test-key-123');
      expect(fetchCall.headers.get('Sec-WebSocket-Version')).toBe('13');
      expect(fetchCall.headers.get('User-Agent')).toBe('test-client');
    });
  });

  describe('HTTP routing (existing behavior)', () => {
    it('should route HTTP requests through containerFetch', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/api/data',
        {
          method: 'GET'
        }
      );

      await proxyToSandbox(request, mockEnv);

      // Should route through containerFetch() for HTTP
      expect(mockSandbox.containerFetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
    });

    it('should route POST requests through containerFetch', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/api/data',
        {
          method: 'POST',
          body: JSON.stringify({ data: 'test' }),
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      expect(mockSandbox.containerFetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
    });

    it('should not detect SSE as WebSocket', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/events',
        {
          headers: {
            Accept: 'text/event-stream'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      // SSE should use HTTP path, not WebSocket path
      expect(mockSandbox.containerFetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
    });
  });

  describe('Token validation', () => {
    it('should validate token for both WebSocket and HTTP requests', async () => {
      const wsRequest = new Request(
        'https://8080-sandbox-token12345678901.example.com/ws',
        {
          headers: { Upgrade: 'websocket' }
        }
      );

      await proxyToSandbox(wsRequest, mockEnv);
      expect(mockSandbox.validatePortToken).toHaveBeenCalledWith(
        8080,
        'token12345678901'
      );

      vi.clearAllMocks();

      const httpRequest = new Request(
        'https://8080-sandbox-token12345678901.example.com/api'
      );
      await proxyToSandbox(httpRequest, mockEnv);
      expect(mockSandbox.validatePortToken).toHaveBeenCalledWith(
        8080,
        'token12345678901'
      );
    });

    it('should reject requests with invalid token', async () => {
      vi.mocked(mockSandbox.validatePortToken as any).mockResolvedValue(false);

      const request = new Request(
        'https://8080-sandbox-invalidtoken1234.example.com/ws',
        {
          headers: { Upgrade: 'websocket' }
        }
      );

      const response = await proxyToSandbox(request, mockEnv);

      expect(response?.status).toBe(404);
      expect(mockSandbox.fetch).not.toHaveBeenCalled();

      const body = await response?.json();
      expect(body).toMatchObject({
        error: 'Access denied: Invalid token or port not exposed',
        code: 'INVALID_TOKEN'
      });
    });

    it('should reject reserved port 3000', async () => {
      // Port 3000 is reserved as control plane port and rejected by validatePort()
      const request = new Request(
        'https://3000-sandbox-anytoken12345678.example.com/status',
        {
          method: 'GET'
        }
      );

      const response = await proxyToSandbox(request, mockEnv);

      // Port 3000 is reserved and should be rejected (extractSandboxRoute returns null)
      expect(response).toBeNull();
      expect(mockSandbox.validatePortToken).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });
  });

  describe('Port routing', () => {
    it('should route to correct port from subdomain', async () => {
      const request = new Request(
        'https://9000-sandbox-token12345678901.example.com/api',
        {
          method: 'GET'
        }
      );

      await proxyToSandbox(request, mockEnv);

      expect(mockSandbox.validatePortToken).toHaveBeenCalledWith(
        9000,
        'token12345678901'
      );
    });
  });

  describe('Non-sandbox requests', () => {
    it('should return null for non-sandbox URLs', async () => {
      const request = new Request('https://example.com/some-path');

      const response = await proxyToSandbox(request, mockEnv);

      expect(response).toBeNull();
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });

    it('should return null for invalid subdomain patterns', async () => {
      const request = new Request('https://invalid-pattern.example.com');

      const response = await proxyToSandbox(request, mockEnv);

      expect(response).toBeNull();
    });
  });

  describe('Error handling', () => {
    it('should handle errors during WebSocket routing', async () => {
      (mockSandbox.fetch as any).mockImplementation(() =>
        Promise.reject(new Error('Connection failed'))
      );

      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/ws',
        {
          headers: {
            Upgrade: 'websocket'
          }
        }
      );

      const response = await proxyToSandbox(request, mockEnv);

      expect(response?.status).toBe(500);
      const text = await response?.text();
      expect(text).toBe('Proxy routing error');
    });

    it('should handle errors during HTTP routing', async () => {
      (mockSandbox.containerFetch as any).mockImplementation(() =>
        Promise.reject(new Error('Service error'))
      );

      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/api'
      );

      const response = await proxyToSandbox(request, mockEnv);

      expect(response?.status).toBe(500);
    });
  });
});
