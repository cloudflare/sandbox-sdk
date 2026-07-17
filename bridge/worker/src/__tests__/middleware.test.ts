import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockProcess, createMockSandbox, sandboxUrl } from './helpers';

// Mock @cloudflare/sandbox before importing app
const mockSandbox = createMockSandbox();
const getSandboxMock = vi.fn(() => mockSandbox);
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: getSandboxMock,
  Sandbox: class {}
}));

// Must import after mock is set up
const { app } = await import('./bridge-app');

// Helper to make requests with specific env bindings
function makeRequest(url: string, opts?: RequestInit, env?: Record<string, unknown>) {
  return app.request(url, opts, env);
}

describe('Auth middleware — /v1/sandbox/*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply sandbox mock defaults
    mockSandbox.exec.mockResolvedValue(createMockProcess());
  });

  it('allows requests with a valid Bearer token', async () => {
    const res = await makeRequest(
      sandboxUrl('test', 'running'),
      { headers: { Authorization: 'Bearer secret' } },
      createMockEnv({ SANDBOX_API_KEY: 'secret' })
    );
    expect(res.status).toBe(200);
  });

  it('rejects requests with an invalid Bearer token', async () => {
    const res = await makeRequest(
      sandboxUrl('test', 'running'),
      { headers: { Authorization: 'Bearer wrong' } },
      createMockEnv({ SANDBOX_API_KEY: 'secret' })
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('rejects requests with no Authorization header when token is set', async () => {
    const res = await makeRequest(sandboxUrl('test', 'running'), {}, createMockEnv({ SANDBOX_API_KEY: 'secret' }));
    // No header means provided is '', which !== 'secret'
    expect(res.status).toBe(401);
  });

  it('allows requests when SANDBOX_API_KEY is not set (auth disabled)', async () => {
    const res = await makeRequest(sandboxUrl('test', 'running'), {}, createMockEnv());
    expect(res.status).toBe(200);
  });
});

describe('sandbox route pool middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not allocate for /running and uses the internal lifecycle query', async () => {
    const env = createMockEnv();
    const res = await makeRequest(sandboxUrl('test', 'running'), {}, env);

    expect(await res.json()).toEqual({ running: true });
    expect(env._poolStub.lookupContainer).toHaveBeenCalledWith('test');
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
    expect(mockSandbox.isRuntimeActive).toHaveBeenCalledOnce();
    expect(mockSandbox.listProcesses).not.toHaveBeenCalled();
  });

  it('returns false without allocating when no assignment exists', async () => {
    const env = createMockEnv();
    env._poolStub.lookupContainer.mockResolvedValueOnce(null);

    const res = await makeRequest(sandboxUrl('test', 'running'), {}, env);

    expect(await res.json()).toEqual({ running: false });
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
    expect(mockSandbox.isRuntimeActive).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'GET', action: 'terminals', status: 200, body: [] },
    {
      method: 'GET',
      action: 'terminals/missing',
      status: 404,
      body: { code: 'not_found' }
    },
    {
      method: 'GET',
      action: 'terminals/missing/connect',
      status: 404,
      body: { code: 'not_found' },
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' }
    },
    {
      method: 'POST',
      action: 'terminals/missing/interrupt',
      status: 404,
      body: { code: 'not_found' }
    },
    {
      method: 'POST',
      action: 'terminals/missing/terminate',
      status: 404,
      body: { code: 'not_found' }
    }
  ])('uses lookup-only pool access for $method /$action', async ({ method, action, status, body, headers }) => {
    const env = createMockEnv();
    env._poolStub.lookupContainer.mockResolvedValueOnce(null);

    const res = await makeRequest(sandboxUrl('test', action), { method, headers }, env);

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject(body);
    expect(env._poolStub.lookupContainer).toHaveBeenCalledWith('test');
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
  });

  it('allocates a runtime when creating a terminal', async () => {
    const env = createMockEnv();

    const res = await makeRequest(
      sandboxUrl('test', 'terminals'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ argv: ['bash'] })
      },
      env
    );

    expect(res.status).toBe(200);
    expect(env._poolStub.getContainer).toHaveBeenCalledWith('test');
  });

  it.each([
    { method: 'GET', action: 'terminals-extra' },
    { method: 'GET', action: 'terminals/id/unknown' },
    { method: 'PUT', action: 'terminals' }
  ])('does not contact the pool for unmatched $method /$action', async ({ method, action }) => {
    const env = createMockEnv();

    const res = await makeRequest(sandboxUrl('test', action), { method }, env);

    expect(res.status).toBe(404);
    expect(env._poolStub.configure).not.toHaveBeenCalled();
    expect(env._poolStub.lookupContainer).not.toHaveBeenCalled();
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'POST', action: 'exec' },
    { method: 'GET', action: 'pty' },
    { method: 'POST', action: 'session' }
  ])('returns a non-waking 404 for removed $method /$action', async ({ method, action }) => {
    const env = createMockEnv();

    const res = await makeRequest(sandboxUrl('test', action), { method }, env);

    expect(res.status).toBe(404);
    expect(env._poolStub.configure).not.toHaveBeenCalled();
    expect(env._poolStub.lookupContainer).not.toHaveBeenCalled();
    expect(env._poolStub.getContainer).not.toHaveBeenCalled();
    expect(getSandboxMock).not.toHaveBeenCalled();
  });
});

describe('Sandbox ID validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.exec.mockResolvedValue(createMockProcess());
  });

  it('accepts a valid base32 ID (lowercase + digits 2-7)', async () => {
    const res = await makeRequest(sandboxUrl('mfrggzdfmy2tqnrz', 'running'), {}, createMockEnv());
    expect(res.status).toBe(200);
  });

  it.each([
    ['ABCDEF', 'uppercase'],
    ['my-sandbox_01', 'hyphens/underscores'],
    ['abc0189', 'digits outside base32'],
    ['foo;rm%20-rf%20%2F', 'shell injection'],
    ['..%2Fetc', 'path traversal']
  ])('rejects ID %s (%s)', async (id) => {
    const url = id.includes('%') ? `${BASE}/v1/sandbox/${id}/running` : sandboxUrl(id, 'running');
    const res = await makeRequest(url, {}, createMockEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid sandbox ID format');
  });

  it('rejects an ID exceeding 128 characters', async () => {
    const longId = 'a'.repeat(129);
    const res = await makeRequest(sandboxUrl(longId, 'running'), {}, createMockEnv());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid sandbox ID format');
  });

  it('accepts an ID of exactly 128 characters', async () => {
    const maxId = 'a'.repeat(128);
    const res = await makeRequest(sandboxUrl(maxId, 'running'), {}, createMockEnv());
    expect(res.status).toBe(200);
  });
});

describe('Auth middleware — /v1/openapi.*', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['/v1/openapi.json', '/v1/openapi.html', '/v1/openapi'])(
    'enforces configured authentication for %s',
    async (path) => {
      const authEnv = createMockEnv({
        SANDBOX_API_KEY: 'expected-token'
      });

      expect((await makeRequest(`${BASE}${path}`, {}, authEnv)).status).toBe(401);
      expect(
        (await makeRequest(`${BASE}${path}`, { headers: { Authorization: 'Bearer wrong-token' } }, authEnv)).status
      ).toBe(401);
      expect(
        (await makeRequest(`${BASE}${path}`, { headers: { Authorization: 'Bearer expected-token' } }, authEnv)).status
      ).toBe(200);
      expect((await makeRequest(`${BASE}${path}?token=expected-token`, {}, authEnv)).status).toBe(200);
    }
  );

  it.each(['/v1/openapi.json', '/v1/openapi.html', '/v1/openapi'])(
    'allows %s when authentication is disabled',
    async (path) => {
      const authDisabledEnv = createMockEnv();
      Reflect.deleteProperty(authDisabledEnv, 'SANDBOX_API_KEY');

      expect((await makeRequest(`${BASE}${path}`, {}, authDisabledEnv)).status).toBe(200);
    }
  );
});

describe('Versioning — old routes return 404', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.exec.mockResolvedValue(createMockProcess());
  });

  it('returns 404 for unversioned /sandbox/:id/running', async () => {
    const res = await makeRequest(`${BASE}/sandbox/test/running`, {}, createMockEnv());
    expect(res.status).toBe(404);
  });

  it('keeps /health unversioned', async () => {
    const res = await makeRequest(`${BASE}/health`, {}, createMockEnv());
    expect(res.status).toBe(200);
  });
});
