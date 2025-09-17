// Vitest globals enabled in vitest.config.ts

/**
 * Tests for URL port detection logic
 * These tests validate the port detection behavior that would be used
 * in the Sandbox.determinePort() method without requiring Cloudflare Workers APIs
 */
/**
 * Note: For explicit port targeting (like port 80 or 443), users should use the switchPort utility:
 * 
 * import { switchPort } from '@cloudflare/containers';
 * const request = new Request('/health');
 * sandbox.fetch(switchPort(request, 80));
 */
describe('Port detection logic', () => {
  // Simulate the determinePort logic from Sandbox class
  function determinePort(url: URL): number {
    // Extract port from proxy requests (e.g., /proxy/8080/*)
    const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)/);
    if (proxyMatch) {
      return parseInt(proxyMatch[1]);
    }

    // Extract port from URL if specified (e.g., http://localhost:8910/health)
    if (url.port) {
      return parseInt(url.port);
    }

    // All other requests go to control plane on port 3000
    // This includes /api/* endpoints and any other control requests
    return 3000;
  }

  describe('proxy URL pattern', () => {
    it('should extract port from proxy URLs', () => {
      const url = new URL('https://example.com/proxy/8080/health');
      expect(determinePort(url)).toBe(8080);
    });

    it('should handle multi-digit ports in proxy paths', () => {
      const url = new URL('https://example.com/proxy/12345/api/test');
      expect(determinePort(url)).toBe(12345);
    });
  });

  describe('URL port detection', () => {
    it('should extract port from localhost URLs', () => {
      const url = new URL('http://localhost:8910/health');
      expect(determinePort(url)).toBe(8910);
    });

    it('should extract port from HTTPS URLs', () => {
      const url = new URL('https://myapp.local:9000/status');
      expect(determinePort(url)).toBe(9000);
    });

    it('should extract port from IP addresses', () => {
      const url = new URL('http://127.0.0.1:3001/test');
      expect(determinePort(url)).toBe(3001);
    });

    it('should default to 3000 for standard ports (use switchPort for explicit targeting)', () => {
      // URL API omits standard ports - users should use switchPort() for explicit targeting
      const url = new URL('http://localhost:80/health');
      expect(url.port).toBe(''); // URL API omits standard ports
      expect(determinePort(url)).toBe(3000); // Defaults to control plane
    });

    it('should default to 3000 for HTTPS standard port 443', () => {
      const url = new URL('https://localhost:443/api');
      expect(url.port).toBe(''); // URL API omits standard ports
      expect(determinePort(url)).toBe(3000); // Defaults to control plane  
    });
  });

  describe('precedence and defaults', () => {
    it('should prioritize proxy path over URL port', () => {
      // URL has port 9000, but proxy path specifies 8080
      const url = new URL('http://localhost:9000/proxy/8080/test');
      expect(determinePort(url)).toBe(8080);
    });

    it('should default to 3000 when no port is specified', () => {
      const url = new URL('http://localhost/health');
      expect(determinePort(url)).toBe(3000);
    });

    it('should default to 3000 for API endpoints without explicit port', () => {
      // No port specified - should default to control plane
      const url = new URL('https://example.com/api/test');
      expect(determinePort(url)).toBe(3000);
    });

    it('should default to control plane for both explicit and implicit standard ports', () => {
      // Standard ports are treated the same - use switchPort() for explicit targeting
      const explicitUrl = new URL('https://localhost:443/health');
      expect(determinePort(explicitUrl)).toBe(3000);

      // No port specified - also defaults to control plane  
      const implicitUrl = new URL('https://localhost/health');
      expect(determinePort(implicitUrl)).toBe(3000);
    });

    it('should extract port from API endpoints when port is specified', () => {
      const url = new URL('https://example.com:4000/api/test');
      expect(determinePort(url)).toBe(4000);
    });
  });

  describe('edge cases', () => {
    it('should handle URLs with query parameters', () => {
      const url = new URL('http://localhost:5000/health?check=true');
      expect(determinePort(url)).toBe(5000);
    });

    it('should handle URLs with hash fragments', () => {
      const url = new URL('http://localhost:6000/app#section');
      expect(determinePort(url)).toBe(6000);
    });

    it('should handle empty port string gracefully', () => {
      // This tests the parseInt behavior with empty strings
      const url = new URL('http://localhost/test');
      expect(determinePort(url)).toBe(3000);
    });
  });
});