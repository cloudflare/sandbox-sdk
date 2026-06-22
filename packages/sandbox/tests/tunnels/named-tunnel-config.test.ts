import { describe, expect, it, vi } from 'vitest';
import { NamedTunnelConfigResolver } from '../../src/tunnels/named-tunnel-config';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('NamedTunnelConfigResolver', () => {
  it('returns token, account id, and zone id from environment', async () => {
    const resolver = new NamedTunnelConfigResolver({
      getEnv: () => ({
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_TUNNEL_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_ZONE_ID: 'zone-id'
      }),
      fetcher: vi.fn<typeof fetch>()
    });

    await expect(resolver.getConfig()).resolves.toEqual({
      token: 'token',
      accountId: 'account-id',
      zoneId: 'zone-id'
    });
  });

  it('clears failed account lookups so later calls retry with fresh env', async () => {
    let env: Record<string, unknown> = {
      CLOUDFLARE_API_TOKEN: 'token'
    };
    const resolver = new NamedTunnelConfigResolver({
      getEnv: () => env,
      fetcher: vi.fn<typeof fetch>(async () =>
        jsonResponse({ success: true, result_info: {} })
      )
    });

    await expect(resolver.getConfig()).rejects.toThrow(
      'Cloudflare token is not scoped to a single account'
    );

    env = {
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_TUNNEL_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_ZONE_ID: 'zone-id'
    };

    await expect(resolver.getConfig()).resolves.toMatchObject({
      accountId: 'account-id',
      zoneId: 'zone-id'
    });
  });

  it('uses the configured fetcher for account and zone discovery', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/user/tokens/verify')) {
        return jsonResponse({
          success: true,
          result_info: { account: { id: 'derived-account-id' } }
        });
      }
      if (url.includes('/zones')) {
        return jsonResponse({
          success: true,
          result: [{ id: 'derived-zone-id', name: 'example.com' }]
        });
      }
      return new Response(`No mock route for ${url}`, { status: 599 });
    });
    const resolver = new NamedTunnelConfigResolver({
      getEnv: () => ({ CLOUDFLARE_API_TOKEN: 'token' }),
      fetcher
    });

    await expect(resolver.getConfig()).resolves.toEqual({
      token: 'token',
      accountId: 'derived-account-id',
      zoneId: 'derived-zone-id'
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
