import { describe, expect, it, vi } from 'vitest';
import { handlePorts } from '../../../src/bridge/handlers/ports';

describe('handlePorts', () => {
  describe('expose', () => {
    it('should expose port and return URL', async () => {
      const mockSandbox = {
        exposePort: vi.fn().mockResolvedValue({
          port: 3000,
          url: 'https://3000-sandbox.example.com',
          token: 'abc123'
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/expose',
        {
          method: 'POST',
          body: JSON.stringify({ port: 3000, hostname: 'sandbox.example.com' })
        }
      );

      const response = await handlePorts(request, mockSandbox as any, [
        'expose'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.port).toBe(3000);
      expect(body.url).toBe('https://3000-sandbox.example.com');
      expect(mockSandbox.exposePort).toHaveBeenCalledWith(3000, {
        name: undefined,
        hostname: 'sandbox.example.com'
      });
    });

    it('should return 400 for missing port', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/expose',
        {
          method: 'POST',
          body: JSON.stringify({ hostname: 'example.com' })
        }
      );

      const response = await handlePorts(request, mockSandbox as any, [
        'expose'
      ]);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });

    it('should return 400 for missing hostname', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/expose',
        {
          method: 'POST',
          body: JSON.stringify({ port: 3000 })
        }
      );

      const response = await handlePorts(request, mockSandbox as any, [
        'expose'
      ]);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });
  });

  describe('unexpose', () => {
    it('should unexpose port', async () => {
      const mockSandbox = {
        unexposePort: vi.fn().mockResolvedValue({ success: true })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/unexpose',
        {
          method: 'POST',
          body: JSON.stringify({ port: 3000 })
        }
      );

      const response = await handlePorts(request, mockSandbox as any, [
        'unexpose'
      ]);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSandbox.unexposePort).toHaveBeenCalledWith(3000);
    });

    it('should return 400 for missing port', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/unexpose',
        {
          method: 'POST',
          body: JSON.stringify({})
        }
      );

      const response = await handlePorts(request, mockSandbox as any, [
        'unexpose'
      ]);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });
  });

  describe('list', () => {
    it('should list exposed ports', async () => {
      const mockSandbox = {
        getExposedPorts: vi.fn().mockResolvedValue({
          ports: [
            { port: 3000, url: 'https://3000.example.com' },
            { port: 8080, url: 'https://8080.example.com' }
          ]
        })
      };

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/list?hostname=sandbox.example.com'
      );

      const response = await handlePorts(request, mockSandbox as any, ['list']);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.ports).toHaveLength(2);
      expect(mockSandbox.getExposedPorts).toHaveBeenCalledWith(
        'sandbox.example.com'
      );
    });

    it('should return 400 for missing hostname', async () => {
      const mockSandbox = {};

      const request = new Request(
        'https://example.com/api/sandbox/test/ports/list'
      );

      const response = await handlePorts(request, mockSandbox as any, ['list']);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_REQUEST');
    });
  });
});
