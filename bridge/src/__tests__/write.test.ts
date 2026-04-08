import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  proxyToSandbox: vi.fn(async () => null),
  Sandbox: class {}
}));

const { app } = await import('../index');

const env = createMockEnv();

function writeRequest(path: string, content = 'hello') {
  return app.request(
    `${BASE}/sandbox/test/file/${path}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content
    },
    env
  );
}

describe('PUT /sandbox/:id/file/* — path validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.writeFile.mockResolvedValue(undefined);
  });

  it('allows a valid path within /workspace', async () => {
    const res = await writeRequest('workspace/main.py');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.writeFile.mock.calls[0] as any[];
    expect(call[0]).toBe('/workspace/main.py');
    expect(call[1]).toBe('hello');
  });

  it('rejects path traversal via ..', async () => {
    const res = await writeRequest('workspace/../etc/shadow');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('path must resolve to a location within /workspace');
  });

  it('rejects an absolute path outside /workspace', async () => {
    const res = await writeRequest('root/.ssh/authorized_keys');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('rejects a path without workspace/ prefix', async () => {
    const res = await writeRequest('main.py');
    expect(res.status).toBe(403);
  });

  it('rejects empty path', async () => {
    const res = await app.request(
      `${BASE}/sandbox/test/file/`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: 'hello'
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('returns 502 on SDK write error', async () => {
    mockSandbox.writeFile.mockRejectedValue(new Error('disk full'));
    const res = await writeRequest('workspace/main.py');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_archive_write_error');
  });
});
