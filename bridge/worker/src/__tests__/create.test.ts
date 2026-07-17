import { describe, expect, it } from 'vitest';
import { app } from './bridge-app';
import { BASE, createMockEnv } from './helpers';

describe('POST /v1/sandbox', () => {
  it('creates a base32 sandbox ID', async () => {
    const res = await app.request(`${BASE}/v1/sandbox`, { method: 'POST' }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[a-z2-7]+$/);
    expect(body.id).toHaveLength(24);
  });

  it('requires bearer auth when configured', async () => {
    const env = createMockEnv({ SANDBOX_API_KEY: 'secret' });

    const unauthenticated = await app.request(`${BASE}/v1/sandbox`, { method: 'POST' }, env);
    expect(unauthenticated.status).toBe(401);

    const authenticated = await app.request(
      `${BASE}/v1/sandbox`,
      { method: 'POST', headers: { Authorization: 'Bearer secret' } },
      env
    );
    expect(authenticated.status).toBe(200);
  });
});
