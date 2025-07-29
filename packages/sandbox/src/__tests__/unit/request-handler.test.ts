import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before importing
vi.mock('../../sandbox', () => ({
  getSandbox: vi.fn()
}));

vi.mock('../../security', () => ({
  logSecurityEvent: vi.fn(),
  sanitizeSandboxId: vi.fn(),
  validatePort: vi.fn()
}));

// Now import after mocking
import { 
  proxyToSandbox, 
  isLocalhostPattern,
  type SandboxEnv,
  type RouteInfo 
} from '../../request-handler';
import { getSandbox } from '../../sandbox';
import { logSecurityEvent, sanitizeSandboxId, validatePort } from '../../security';

describe('Request Handler', () => {
  let mockSandbox: any;
  let mockEnv: SandboxEnv;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock the sandbox instance
    mockSandbox = {
      validatePortToken: vi.fn(),
      containerFetch: vi.fn(),
    };

    // Mock the environment
    mockEnv = {
      Sandbox: {} as any,
    };

    // Mock getSandbox to return our mock sandbox
    vi.mocked(getSandbox).mockReturnValue(mockSandbox);

    // Mock security functions with default implementations
    vi.mocked(validatePort).mockImplementation((port: number) => {
      return port >= 1024 && port <= 65535 && port !== 8080; // Standard validation
    });

    vi.mocked(sanitizeSandboxId).mockImplementation((id: string) => {
      if (!id || id.length === 0) throw new Error('Empty sandbox ID');
      if (id.includes('..') || id.includes('/')) throw new Error('Invalid characters');
      return id;
    });

    vi.mocked(logSecurityEvent).mockImplementation(() => {});

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    consoleErrorSpy.mockRestore();
  });

  describe('isLocalhostPattern', () => {
    it('should recognize localhost patterns', () => {
      expect(isLocalhostPattern('localhost')).toBe(true);
      expect(isLocalhostPattern('localhost:3000')).toBe(true);
      expect(isLocalhostPattern('127.0.0.1')).toBe(true);
      expect(isLocalhostPattern('127.0.0.1:8080')).toBe(true);
      expect(isLocalhostPattern('::1')).toBe(true);
      expect(isLocalhostPattern('[::1]')).toBe(true);
      expect(isLocalhostPattern('[::1]:8080')).toBe(true);
      expect(isLocalhostPattern('0.0.0.0')).toBe(true);
    });

    it('should reject non-localhost patterns', () => {
      expect(isLocalhostPattern('example.com')).toBe(false);
      expect(isLocalhostPattern('sandbox.dev')).toBe(false);
      expect(isLocalhostPattern('192.168.1.1')).toBe(false);
      expect(isLocalhostPattern('10.0.0.1')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isLocalhostPattern('')).toBe(false);
      expect(isLocalhostPattern('localhostx')).toBe(false);
      expect(isLocalhostPattern('xlocalhost')).toBe(false);
    });
  });

  describe('proxyToSandbox - URL parsing', () => {
    it('should return null for non-sandbox URLs', async () => {
      const request = new Request('https://example.com/api/test');
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).toBeNull();
    });

    it('should return null for malformed subdomain patterns', async () => {
      const malformedUrls = [
        'https://invalid-pattern.example.com/test',
        'https://3001.example.com/test', // Missing sandbox ID and token
        'https://3001-sandbox.example.com/test', // Missing token
        'https://port-sandbox-token.example.com/test', // Invalid port format
      ];

      for (const url of malformedUrls) {
        const request = new Request(url);
        const result = await proxyToSandbox(request, mockEnv);
        expect(result).toBeNull();
      }

      // Should log malformed subdomain attempts
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'MALFORMED_SUBDOMAIN_ATTEMPT',
        expect.any(Object),
        'medium'
      );
    });

    it('should parse valid subdomain patterns correctly', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/api/test?param=value');
      
      // Mock token validation to succeed
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('success'));

      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(mockSandbox.validatePortToken).toHaveBeenCalledWith(3001, 'abc123def456');
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:3001/api/test?param=value',
          method: 'GET'
        }),
        3001
      );
    });

    it('should handle control plane port (3000) without token validation', async () => {
      const request = new Request('https://3000-sandbox-abc123def456.example.com/api/test');
      
      mockSandbox.containerFetch.mockResolvedValue(new Response('control plane'));

      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      // Should not validate token for port 3000
      expect(mockSandbox.validatePortToken).not.toHaveBeenCalled();
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:3000/api/test',
        }),
        3000
      );
    });
  });

  describe('proxyToSandbox - Security validation', () => {
    it('should reject invalid ports', async () => {
      // Mock validatePort to return false for invalid ports
      vi.mocked(validatePort).mockReturnValue(false);
      
      const request = new Request('https://8080-sandbox-abc123def456.example.com/test');
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).toBeNull();
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'INVALID_PORT_IN_SUBDOMAIN',
        expect.objectContaining({
          port: 8080,
          portStr: '8080',
          sandboxId: 'sandbox',
        }),
        'high'
      );
    });

    it('should reject malformed subdomain patterns', async () => {
      // The regex pattern rejects `invalid..id` before reaching sanitization
      const request = new Request('https://3001-invalid..id-abc123def456.example.com/test');
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).toBeNull();
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'MALFORMED_SUBDOMAIN_ATTEMPT',
        expect.objectContaining({
          hostname: '3001-invalid..id-abc123def456.example.com',
          url: 'https://3001-invalid..id-abc123def456.example.com/test'
        }),
        'medium'
      );
    });

    it('should reject invalid sandbox IDs during sanitization', async () => {
      // Mock sanitizeSandboxId to throw for invalid IDs
      vi.mocked(sanitizeSandboxId).mockImplementation(() => {
        throw new Error('Invalid characters in sandbox ID');
      });
      
      const request = new Request('https://3001-validformat-abc123def456.example.com/test');
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).toBeNull();
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'INVALID_SANDBOX_ID_IN_SUBDOMAIN',
        expect.objectContaining({
          sandboxId: 'validformat',
          port: 3001,
          error: 'Invalid characters in sandbox ID'
        }),
        'high'
      );
      
      // Reset sanitizeSandboxId for subsequent tests
      vi.mocked(sanitizeSandboxId).mockReturnValue('sandbox');
    });

    it('should reject sandbox IDs that are too long', async () => {
      const longId = 'a'.repeat(64); // Exceeds 63 character DNS limit
      const request = new Request(`https://3001-${longId}-abc123def456.example.com/test`);
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).toBeNull();
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'SANDBOX_ID_LENGTH_VIOLATION',
        expect.objectContaining({
          sandboxId: longId,
          length: 64,
          port: 3001
        }),
        'medium'
      );
    });

    it('should reject invalid tokens for user ports', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/test');
      
      // Mock token validation to fail
      mockSandbox.validatePortToken.mockResolvedValue(false);
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(result!.status).toBe(404);
      
      const body = await result!.json();
      expect(body).toEqual({
        error: 'Access denied: Invalid token or port not exposed',
        code: 'INVALID_TOKEN'
      });
      
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'INVALID_TOKEN_ACCESS_BLOCKED',
        expect.objectContaining({
          port: 3001,
          sandboxId: 'sandbox',
          path: '/test'
        }),
        'high'
      );
    });

    it('should allow valid tokens for user ports', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/test');
      
      // Mock token validation to succeed
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('authorized'));
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(mockSandbox.validatePortToken).toHaveBeenCalledWith(3001, 'abc123def456');
      expect(mockSandbox.containerFetch).toHaveBeenCalled();
    });
  });

  describe('proxyToSandbox - Request proxying', () => {
    beforeEach(() => {
      // Reset all mocks for each test in this group
      vi.mocked(validatePort).mockReturnValue(true);
      vi.mocked(sanitizeSandboxId).mockReturnValue('sandbox');
      vi.mocked(logSecurityEvent).mockImplementation(() => {});
      
      // Default to successful token validation  
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('success'));
      
      // Make sure getSandbox returns our mock
      vi.mocked(getSandbox).mockReturnValue(mockSandbox);
    });

    it('should proxy GET requests with proper headers', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/api/data?id=123', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer token123',
          'User-Agent': 'TestAgent/1.0'
        }
      });
      
      mockSandbox.containerFetch.mockResolvedValue(new Response('proxy success'));
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
        expect.any(Request),
        3001
      );
      
      // Verify the proxied request details
      const [proxiedRequest, port] = mockSandbox.containerFetch.mock.calls[0];
      expect(proxiedRequest.method).toBe('GET');
      expect(proxiedRequest.url).toBe('http://localhost:3001/api/data?id=123');
      expect(proxiedRequest.headers.get('Authorization')).toBe('Bearer token123');
      expect(proxiedRequest.headers.get('User-Agent')).toBe('TestAgent/1.0');
      expect(proxiedRequest.headers.get('X-Original-URL')).toBe('https://3001-sandbox-abc123def456.example.com/api/data?id=123');
      expect(proxiedRequest.headers.get('X-Forwarded-Host')).toBe('3001-sandbox-abc123def456.example.com');
      expect(proxiedRequest.headers.get('X-Forwarded-Proto')).toBe('https');
      expect(proxiedRequest.headers.get('X-Sandbox-Name')).toBe('sandbox');
      expect(port).toBe(3001);
    });

    it('should proxy POST requests with body', async () => {
      // Explicitly reset mocks for this test
      mockSandbox.validatePortToken.mockReset();
      mockSandbox.containerFetch.mockReset();
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('created'));
      
      const requestBody = JSON.stringify({ data: 'test' });
      const request = new Request('https://3001-sandbox-abc123def456.example.com/api/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: requestBody
      });
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(result!.status).toBe(200);
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
        expect.any(Request),
        3001
      );
      
      // Verify the proxied request details
      const [proxiedRequest, port] = mockSandbox.containerFetch.mock.calls[0];
      expect(proxiedRequest.method).toBe('POST');
      expect(proxiedRequest.headers.get('Content-Type')).toBe('application/json');
      expect(port).toBe(3001);
    });

    it('should handle different HTTP methods', async () => {
      const methods = ['PUT', 'DELETE', 'PATCH', 'OPTIONS'];
      
      for (const method of methods) {
        const request = new Request('https://3001-sandbox-abc123def456.example.com/test', {
          method
        });
        
        mockSandbox.containerFetch.mockResolvedValue(new Response(`${method} success`));
        
        const result = await proxyToSandbox(request, mockEnv);
        
        expect(result).not.toBeNull();
        expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
          expect.objectContaining({
            method
          }),
          3001
        );
      }
    });

    it('should preserve query parameters and paths', async () => {
      const testCases = [
        {
          url: 'https://3001-sandbox-abc123def456.example.com/',
          expectedPath: 'http://localhost:3001/'
        },
        {
          url: 'https://3001-sandbox-abc123def456.example.com/api/v1/users',
          expectedPath: 'http://localhost:3001/api/v1/users'
        },
        {
          url: 'https://3001-sandbox-abc123def456.example.com/search?q=test&limit=10',
          expectedPath: 'http://localhost:3001/search?q=test&limit=10'
        },
        {
          url: 'https://3001-sandbox-abc123def456.example.com/path/with/encoded%20spaces',
          expectedPath: 'http://localhost:3001/path/with/encoded%20spaces'
        }
      ];

      for (const testCase of testCases) {
        const request = new Request(testCase.url);
        mockSandbox.containerFetch.mockResolvedValue(new Response('success'));
        
        await proxyToSandbox(request, mockEnv);
        
        expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
          expect.objectContaining({
            url: testCase.expectedPath
          }),
          3001
        );
      }
    });
  });

  describe('proxyToSandbox - Error handling', () => {
    it('should handle container fetch errors gracefully', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/test');
      
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockImplementation(() => {
        throw new Error('Container not responding');
      });
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(result!.status).toBe(500);
      expect(await result!.text()).toBe('Proxy routing error');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Sandbox] Proxy routing error:',
        expect.any(Error)
      );
    });

    it('should handle token validation errors', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/test');
      
      mockSandbox.validatePortToken.mockRejectedValue(new Error('Token validation failed'));
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(result!.status).toBe(500);
      expect(await result!.text()).toBe('Proxy routing error');
    });

    it('should handle getSandbox errors', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/test');
      
      vi.mocked(getSandbox).mockImplementation(() => {
        throw new Error('Failed to get sandbox');
      });
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(result!.status).toBe(500);
    });
  });

  describe('proxyToSandbox - Security logging', () => {
    it('should log successful route extraction', async () => {
      const request = new Request('https://3001-sandbox-abc123def456.example.com/api/test');
      
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('success'));
      
      await proxyToSandbox(request, mockEnv);
      
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'SANDBOX_ROUTE_EXTRACTED',
        expect.objectContaining({
          port: 3001,
          sandboxId: 'sandbox',
          domain: 'example.com',
          path: '/api/test',
          hostname: '3001-sandbox-abc123def456.example.com',
          hasToken: true
        }),
        'low'
      );
    });

    it('should log all security events with proper severity levels', async () => {
      // Test various security events with different severity levels
      const securityTests = [
        {
          url: 'https://invalid-pattern.example.com/test',
          expectedEvent: 'MALFORMED_SUBDOMAIN_ATTEMPT',
          expectedSeverity: 'medium'
        }
      ];

      for (const test of securityTests) {
        vi.clearAllMocks();
        const request = new Request(test.url);
        await proxyToSandbox(request, mockEnv);
        
        expect(logSecurityEvent).toHaveBeenCalledWith(
          test.expectedEvent,
          expect.any(Object),
          test.expectedSeverity
        );
      }
    });
  });

  describe('proxyToSandbox - Complex scenarios', () => {
    it('should handle very long URLs correctly', async () => {
      const longPath = '/api/' + 'segment/'.repeat(50) + 'endpoint';
      const longQuery = '?' + 'param=value&'.repeat(20).slice(0, -1);
      const request = new Request(`https://3001-sandbox-abc123def456.example.com${longPath}${longQuery}`);
      
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('success'));
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `http://localhost:3001${longPath}${longQuery}`
        }),
        3001
      );
    });

    it('should handle special characters in sandbox IDs', async () => {
      const request = new Request('https://3001-my_sandbox-123-abc123def456.example.com/test');
      
      mockSandbox.validatePortToken.mockResolvedValue(true);
      mockSandbox.containerFetch.mockResolvedValue(new Response('success'));
      
      const result = await proxyToSandbox(request, mockEnv);
      
      expect(result).not.toBeNull();
      expect(sanitizeSandboxId).toHaveBeenCalledWith('my_sandbox-123');
    });

    it('should handle different port ranges correctly', async () => {
      const validPorts = [1024, 3000, 8000, 9000, 65535];
      
      for (const port of validPorts) {
        vi.clearAllMocks();
        const request = new Request(`https://${port}-sandbox-abc123def456.example.com/test`);
        
        if (port !== 3000) {
          mockSandbox.validatePortToken.mockResolvedValue(true);
        }
        mockSandbox.containerFetch.mockResolvedValue(new Response('success'));
        
        const result = await proxyToSandbox(request, mockEnv);
        
        expect(result).not.toBeNull();
        expect(mockSandbox.containerFetch).toHaveBeenCalledWith(
          expect.any(Object),
          port
        );
      }
    });
  });
});