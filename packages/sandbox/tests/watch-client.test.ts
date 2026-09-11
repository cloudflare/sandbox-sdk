import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchClient, watchLocalMountRoute } from '../src/clients/watch-client';
import { UnsupportedMountWatchError } from '../src/watch-capability';

describe('WatchClient', () => {
  let client: WatchClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    client = new WatchClient({
      baseUrl: 'http://test.com',
      port: 3000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should post mount watches to the internal endpoint', async () => {
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"watching","path":"/data","watchId":"watch-1"}\n\n'
              )
            );
            controller.close();
          }
        }),
        { status: 200 }
      )
    );

    await watchLocalMountRoute(client, { path: '/data', recursive: true });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.com/api/watch/mount',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/data', recursive: true })
      })
    );
  });

  it('should not expose mount watches on the route client', () => {
    expect('watchMount' in client).toBe(false);
  });

  it('should translate a missing mount route at the transport boundary', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'UNKNOWN_ERROR',
          message: 'The requested endpoint was not found',
          context: {},
          httpStatus: 404,
          timestamp: new Date().toISOString()
        }),
        { status: 404 }
      )
    );

    await expect(
      watchLocalMountRoute(client, { path: '/data' })
    ).rejects.toBeInstanceOf(UnsupportedMountWatchError);
  });

  it('should post to the retained change check endpoint', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          status: 'changed',
          version: 'watch-1:2',
          timestamp: '2026-03-17T00:00:00.000Z'
        }),
        { status: 200 }
      )
    );

    const result = await client.checkChanges({
      path: '/workspace/test',
      since: 'watch-1:1'
    });

    expect(result).toEqual({
      success: true,
      status: 'changed',
      version: 'watch-1:2',
      timestamp: '2026-03-17T00:00:00.000Z'
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.com/api/watch/check',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });
});
