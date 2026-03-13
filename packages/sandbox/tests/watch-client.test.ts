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

  it('should normalize legacy dirty state from ensureWatch', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          watch: {
            watchId: 'watch-1',
            path: '/workspace/test',
            recursive: true,
            cursor: 0,
            dirty: false,
            overflowed: false,
            lastEventAt: null,
            expiresAt: null,
            subscriberCount: 0,
            startedAt: '2023-01-01T00:00:00Z'
          },
          leaseToken: 'lease-1',
          timestamp: '2023-01-01T00:00:00Z'
        }),
        { status: 200 }
      )
    );

    const result = await client.ensureWatch({ path: '/workspace/test' });

    expect(result.watch.changed).toBe(false);
  });

  it('should normalize legacy dirty state from getWatchState', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          watch: {
            watchId: 'watch-1',
            path: '/workspace/test',
            recursive: true,
            cursor: 2,
            dirty: true,
            overflowed: false,
            lastEventAt: null,
            expiresAt: null,
            subscriberCount: 0,
            startedAt: '2023-01-01T00:00:00Z'
          },
          timestamp: '2023-01-01T00:00:00Z'
        }),
        { status: 200 }
      )
    );

    const result = await client.getWatchState('watch-1');

    expect(result.watch.changed).toBe(true);
  });

  it('should normalize legacy dirty state from checkpointWatch', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          checkpointed: true,
          watch: {
            watchId: 'watch-1',
            path: '/workspace/test',
            recursive: true,
            cursor: 2,
            dirty: false,
            overflowed: false,
            lastEventAt: null,
            expiresAt: null,
            subscriberCount: 0,
            startedAt: '2023-01-01T00:00:00Z'
          },
          timestamp: '2023-01-01T00:00:00Z'
        }),
        { status: 200 }
      )
    );

    const result = await client.checkpointWatch('watch-1', {
      cursor: 2,
      leaseToken: 'lease-1'
    });

    expect(result.watch.changed).toBe(false);
  });
});
