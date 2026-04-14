import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function readRequest(path: string) {
  return app.request(
    `${BASE}/v1/sandbox/test/file/${path}`,
    {
      method: 'GET'
    },
    env
  );
}

describe('GET /v1/sandbox/:id/file/* — path validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.readFileStream.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('file content'));
          controller.close();
        }
      })
    );
  });

  it('allows a valid path within /workspace', async () => {
    const res = await readRequest('workspace/main.py');
    expect(res.status).toBe(200);
    expect(mockSandbox.readFileStream).toHaveBeenCalledWith('/workspace/main.py');
    const body = await res.text();
    expect(body).toBe('file content');
  });

  it('rejects path traversal via ..', async () => {
    const res = await readRequest('workspace/../etc/passwd');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('path must resolve to a location within /workspace');
  });

  it('rejects an absolute path outside /workspace', async () => {
    const res = await readRequest('etc/passwd');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('rejects a path without workspace/ prefix', async () => {
    const res = await readRequest('main.py');
    expect(res.status).toBe(403);
  });

  it('rejects empty path', async () => {
    const res = await app.request(
      `${BASE}/v1/sandbox/test/file/`,
      {
        method: 'GET'
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when file is not found', async () => {
    mockSandbox.readFileStream.mockRejectedValue(Object.assign(new Error('not found'), { code: 'FILE_NOT_FOUND' }));
    const res = await readRequest('workspace/missing.txt');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('workspace_read_not_found');
  });

  it('returns 502 on SDK transport error', async () => {
    mockSandbox.readFileStream.mockRejectedValue(new Error('connection lost'));
    const res = await readRequest('workspace/main.py');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('exec_transport_error');
  });
});
