import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PortClient } from '../src/clients/port-client';
import { SandboxError } from '../src/errors';

describe('PortClient', () => {
  let client: PortClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new PortClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  describe('watchPort', () => {
    it('opens a port readiness SSE stream', async () => {
      const stream = new ReadableStream<Uint8Array>();
      mockFetch.mockResolvedValue(new Response(stream, { status: 200 }));

      const result = await client.watchPort({
        port: 8080,
        mode: 'http',
        path: '/health'
      });

      expect(result).toBe(stream);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.com/api/port-watch',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            port: 8080,
            mode: 'http',
            path: '/health'
          })
        })
      );
    });

    it('throws SandboxError when the readiness stream response is an error', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'UNKNOWN_ERROR',
            message: 'Port watch failed',
            context: {},
            httpStatus: 500,
            timestamp: new Date().toISOString()
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      );

      await expect(
        client.watchPort({ port: 8080, mode: 'tcp' })
      ).rejects.toBeInstanceOf(SandboxError);
    });
  });
});
