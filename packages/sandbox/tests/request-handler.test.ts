import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyToSandbox, type SandboxEnv } from '../src/request-handler';
import type { Sandbox } from '../src/sandbox';

vi.mock('../src/sandbox', () => {
  const mockFn = vi.fn();
  return {
    getSandbox: mockFn,
    Sandbox: vi.fn()
  };
});

import { getSandbox } from '../src/sandbox';

describe('proxyToSandbox - preview URL routing', () => {
  let mockSandbox: Pick<Sandbox, 'fetch' | 'containerFetch'>;
  let mockEnv: SandboxEnv;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSandbox = {
      fetch: vi.fn().mockResolvedValue(new Response('Preview response')),
      containerFetch: vi.fn().mockResolvedValue(new Response('HTTP response'))
    };

    mockEnv = {
      Sandbox: {} as DurableObjectNamespace<Sandbox>
    };

    vi.mocked(getSandbox).mockReturnValue(mockSandbox as Sandbox);
  });

  function getForwardedRequest(): Request {
    const request = vi.mocked(mockSandbox.fetch).mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    return request as Request;
  }

  describe('routing to the Sandbox Durable Object', () => {
    it('routes WebSocket preview requests through the Sandbox fetch boundary', async () => {
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

      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();

      const forwarded = getForwardedRequest();
      expect(forwarded.headers.get('Upgrade')).toBe('websocket');
      expect(forwarded.headers.get('Connection')).toBe('Upgrade');
      expect(forwarded.headers.get('x-sandbox-preview-proxy')).toBe('1');
      expect(forwarded.headers.get('x-sandbox-preview-port')).toBe('8080');
      expect(forwarded.headers.get('x-sandbox-preview-token')).toBe(
        'token12345678901'
      );
    });

    it('preserves original WebSocket headers', async () => {
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

      const forwarded = getForwardedRequest();
      expect(forwarded.headers.get('Upgrade')).toBe('websocket');
      expect(forwarded.headers.get('Sec-WebSocket-Key')).toBe('test-key-123');
      expect(forwarded.headers.get('Sec-WebSocket-Version')).toBe('13');
      expect(forwarded.headers.get('User-Agent')).toBe('test-client');
    });

    it('routes HTTP preview requests through the Sandbox fetch boundary', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/api/data',
        {
          method: 'GET'
        }
      );

      await proxyToSandbox(request, mockEnv);

      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();

      const forwarded = getForwardedRequest();
      expect(forwarded.headers.get('x-sandbox-preview-proxy')).toBe('1');
      expect(forwarded.headers.get('x-sandbox-preview-port')).toBe('8080');
      expect(forwarded.headers.get('x-sandbox-preview-token')).toBe(
        'token12345678901'
      );
      expect(forwarded.headers.get('x-sandbox-preview-sandbox-id')).toBe(
        'sandbox'
      );
    });

    it('preserves POST requests and request headers', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/api/data',
        {
          method: 'POST',
          body: JSON.stringify({ data: 'test' }),
          headers: {
            'Content-Type': 'application/json',
            'X-Test-Header': 'test-value'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      const forwarded = getForwardedRequest();
      expect(forwarded.method).toBe('POST');
      expect(forwarded.headers.get('Content-Type')).toBe('application/json');
      expect(forwarded.headers.get('X-Test-Header')).toBe('test-value');
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });

    it('does not treat SSE requests as WebSocket requests', async () => {
      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/events',
        {
          headers: {
            Accept: 'text/event-stream'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
      expect(getForwardedRequest().headers.get('Accept')).toBe(
        'text/event-stream'
      );
    });

    it('routes to the parsed preview port and sandbox ID', async () => {
      const request = new Request(
        'https://9000-sandbox-token12345678901.example.com/api',
        {
          method: 'GET'
        }
      );

      await proxyToSandbox(request, mockEnv);

      expect(getSandbox).toHaveBeenCalledWith(mockEnv.Sandbox, 'sandbox', {
        normalizeId: true
      });

      const forwarded = getForwardedRequest();
      expect(forwarded.headers.get('x-sandbox-preview-port')).toBe('9000');
      expect(forwarded.headers.get('x-sandbox-preview-token')).toBe(
        'token12345678901'
      );
    });

    it('overwrites spoofed internal preview headers with parsed route values', async () => {
      const request = new Request(
        'https://8080-test-sandbox-token12345678901.example.com/hello',
        {
          headers: {
            'x-sandbox-preview-proxy': '0',
            'x-sandbox-preview-port': '9999',
            'x-sandbox-preview-token': 'wrongtoken',
            'x-sandbox-preview-sandbox-id': 'wrong-sandbox'
          }
        }
      );

      await proxyToSandbox(request, mockEnv);

      const forwarded = getForwardedRequest();
      expect(forwarded.headers.get('x-sandbox-preview-proxy')).toBe('1');
      expect(forwarded.headers.get('x-sandbox-preview-port')).toBe('8080');
      expect(forwarded.headers.get('x-sandbox-preview-token')).toBe(
        'token12345678901'
      );
      expect(forwarded.headers.get('x-sandbox-preview-sandbox-id')).toBe(
        'test-sandbox'
      );
    });
  });

  describe('Sandbox response forwarding', () => {
    it('returns invalid-token responses from the Sandbox Durable Object', async () => {
      vi.mocked(mockSandbox.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Access denied: Invalid token or port not exposed',
            code: 'INVALID_TOKEN'
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      );

      const request = new Request(
        'https://8080-sandbox-invalidtoken1234.example.com/api'
      );

      const response = await proxyToSandbox(request, mockEnv);

      expect(response?.status).toBe(404);
      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
      expect(await response?.json()).toMatchObject({
        code: 'INVALID_TOKEN'
      });
    });

    it('returns stale preview URL responses from the Sandbox Durable Object', async () => {
      vi.mocked(mockSandbox.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'Preview URL is stale because the sandbox runtime is not active',
            code: 'STALE_PREVIEW_URL'
          }),
          {
            status: 410,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      );

      const request = new Request(
        'https://8080-sandbox-token12345678901.example.com/api'
      );

      const response = await proxyToSandbox(request, mockEnv);

      expect(response?.status).toBe(410);
      expect(mockSandbox.fetch).toHaveBeenCalledTimes(1);
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
      expect(await response?.json()).toMatchObject({
        code: 'STALE_PREVIEW_URL'
      });
    });
  });

  describe('Non-sandbox requests', () => {
    it('returns null for non-sandbox URLs without creating a sandbox', async () => {
      const request = new Request('https://example.com/some-path');

      const response = await proxyToSandbox(request, mockEnv);

      expect(response).toBeNull();
      expect(getSandbox).not.toHaveBeenCalled();
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });

    it('returns null for invalid subdomain patterns without creating a sandbox', async () => {
      const request = new Request('https://invalid-pattern.example.com');

      const response = await proxyToSandbox(request, mockEnv);

      expect(response).toBeNull();
      expect(getSandbox).not.toHaveBeenCalled();
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });

    it('returns null for missing preview URL tokens without creating a sandbox', async () => {
      const request = new Request('https://8080-sandbox.example.com');

      const response = await proxyToSandbox(request, mockEnv);

      expect(response).toBeNull();
      expect(getSandbox).not.toHaveBeenCalled();
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });

    it('rejects reserved port 3000 before creating a sandbox', async () => {
      const request = new Request(
        'https://3000-sandbox-anytoken12345678.example.com/status',
        {
          method: 'GET'
        }
      );

      const response = await proxyToSandbox(request, mockEnv);

      expect(response).toBeNull();
      expect(getSandbox).not.toHaveBeenCalled();
      expect(mockSandbox.fetch).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('returns a proxy routing error when Sandbox fetch fails', async () => {
      vi.mocked(mockSandbox.fetch).mockRejectedValue(
        new Error('Connection failed')
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
      expect(await response?.text()).toBe('Proxy routing error');
    });
  });
});
