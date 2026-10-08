import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('basic Agents API Worker', () => {
  it('reports health', async () => {
    const response = await SELF.fetch('https://example.test/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
