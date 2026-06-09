import { describe, expect, it } from 'bun:test';
import { webSocketUpgradeFailedResponse } from '../src/server';

describe('server WebSocket upgrade failures', () => {
  it('returns 503 so SDK upgrade transports can retry', async () => {
    const response = webSocketUpgradeFailedResponse();

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('WebSocket upgrade failed');
  });
});
