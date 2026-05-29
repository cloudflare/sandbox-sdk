import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function exposedPortRequest(port: string | number, body?: unknown) {
  const init: RequestInit & { headers: Record<string, string> } = {
    method: 'POST',
    headers: {}
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(`${BASE}/v1/sandbox/test/exposed-port/${port}`, init, env);
}

describe('POST /v1/sandbox/:id/exposed-port/:port', () => {
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

  it('creates or reuses an ephemeral public endpoint', async () => {
    const res = await exposedPortRequest(8080);

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

  it('passes the requested name for a named public endpoint', async () => {
    mockSandbox.tunnels.get.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      port: 8080,
      url: 'https://app.example.com',
      hostname: 'app.example.com',
      name: 'app',
      createdAt: '2026-05-29T00:00:00.000Z'
    });

    const res = await exposedPortRequest(8080, { name: 'app' });

    expect(res.status).toBe(200);
    expect(mockSandbox.tunnels.get).toHaveBeenCalledWith(8080, { name: 'app' });
    await expect(res.json()).resolves.toMatchObject({
      id: '11111111-2222-3333-4444-555555555555',
      url: 'https://app.example.com',
      name: 'app'
    });
  });

  it('rejects a non-string endpoint name before calling the SDK', async () => {
    const res = await exposedPortRequest(8080, { name: 123 });

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.get).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      code: 'invalid_request',
      error: 'name must be a string when provided'
    });
  });

  it('rejects an invalid endpoint name before calling the SDK', async () => {
    const res = await exposedPortRequest(8080, { name: 'Bad.Name' });

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.get).not.toHaveBeenCalled();
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('invalid_request');
    expect(body.error).toContain('valid DNS label');
  });

  it('rejects an invalid exposed port before calling the SDK', async () => {
    const res = await exposedPortRequest(3000);

    expect(res.status).toBe(400);
    expect(mockSandbox.tunnels.get).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      code: 'invalid_request'
    });
  });

  it('maps endpoint provisioning failures to exposed port errors', async () => {
    mockSandbox.tunnels.get.mockRejectedValue(new Error('cloudflared failed'));

    const res = await exposedPortRequest(8080, { name: 'app' });

    expect(res.status).toBe(502);
    expect(mockSandbox.tunnels.get).toHaveBeenCalledWith(8080, { name: 'app' });
    await expect(res.json()).resolves.toMatchObject({
      code: 'exposed_port_error',
      error: 'exposed port failed: cloudflared failed'
    });
  });
});
