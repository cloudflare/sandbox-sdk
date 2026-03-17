import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchClient } from '../src/clients/watch-client';

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
