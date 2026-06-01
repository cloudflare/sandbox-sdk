import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function tunnelRequest(port: string | number, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return app.request(`${BASE}/v1/sandbox/test/tunnel/${port}`, init, env);
}

function createTunnelRequest(port: string | number, body?: unknown) {
  const init: RequestInit & { headers: Record<string, string> } = {
    method: 'POST',
    headers: {}
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return tunnelRequest(port, init);
}

describe('POST /v1/sandbox/:id/tunnel/:port', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.tunnels.get.mockResolvedValue({
      id: 'quick-abc123',
      port: 8080,
      url: 'https://abc.trycloudflare.com',
      hostname: 'abc.trycloudflare.com',
      createdAt: '2026-05-29T00:00:00.000Z'
    });
  });

  it('creates or reuses an ephemeral tunnel', async () => {
    const res = await createTunnelRequest(8080);

    expect(res.status).toBe(200);
    expect(mockSandbox.tunnels.get).toHaveBeenCalledWith(8080, undefined);
    await expect(res.json()).resolves.toEqual({
      id: 'quick-abc123',
      port: 8080,
      url: 'https://abc.trycloudflare.com',
      hostname: 'abc.trycloudflare.com',
      createdAt: '2026-05-29T00:00:00.000Z'
    });
  });

  it('passes the requested name for a named tunnel', async () => {
    mockSandbox.tunnels.get.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: 'https://app.example.com',
      hostname: 'app.example.com',
      name: 'app',
      createdAt: '2026-05-29T00:00:00.000Z'
    });

    const res = await createTunnelRequest(8080, { name: 'app' });

    expect(res.status).toBe(200);
    expect(mockSandbox.tunnels.get).toHaveBeenCalledWith(8080, { name: 'app' });
    await expect(res.json()).resolves.toMatchObject({
      id: '11111111-2222-3333-4444-555555555555',
      url: 'https://app.example.com',
      name: 'app'
    });
  });

  it('rejects a non-string tunnel name before calling the SDK', async () => {
    const res = await createTunnelRequest(8080, { name: 123 });

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.get).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      code: 'invalid_request',
      error: 'name must be a string when provided'
    });
  });

  it('rejects an invalid tunnel name before calling the SDK', async () => {
    const res = await createTunnelRequest(8080, { name: 'Bad.Name' });

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.get).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('invalid_request');
    expect(body.error).toContain('valid DNS label');
  });

  it('rejects an invalid tunnel port before calling the SDK', async () => {
    const res = await createTunnelRequest(3000);

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.get).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      code: 'invalid_request'
    });
  });

  it('maps tunnel provisioning failures to tunnel errors', async () => {
    mockSandbox.tunnels.get.mockRejectedValue(new Error('cloudflared failed'));

    const res = await createTunnelRequest(8080, { name: 'app' });

    expect(res.status).toBe(502);
    expect(mockSandbox.tunnels.get).toHaveBeenCalledWith(8080, { name: 'app' });
    await expect(res.json()).resolves.toMatchObject({
      code: 'tunnel_error',
      error: 'tunnel failed: cloudflared failed'
    });
  });
});

describe('DELETE /v1/sandbox/:id/tunnel/:port', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('destroys the tunnel for a sandbox port', async () => {
    const res = await tunnelRequest(8080, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(mockSandbox.tunnels.destroy).toHaveBeenCalledWith(8080);
  });

  it('rejects an invalid tunnel port before calling the SDK', async () => {
    const res = await tunnelRequest(3000, { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.destroy).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      code: 'invalid_request'
    });
  });

  it('maps tunnel cleanup failures to tunnel errors', async () => {
    mockSandbox.tunnels.destroy.mockRejectedValue(new Error('cleanup failed'));

    const res = await tunnelRequest(8080, { method: 'DELETE' });

    expect(res.status).toBe(502);
    expect(mockSandbox.tunnels.destroy).toHaveBeenCalledWith(8080);
    await expect(res.json()).resolves.toEqual({
      code: 'tunnel_error',
      error: 'tunnel failed: cleanup failed'
    });
  });
});
