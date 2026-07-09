import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function unmountRequest(body: unknown) {
  return app.request(
    `${BASE}/v1/sandbox/test/unmount`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    env
  );
}

describe('POST /v1/sandbox/:id/unmount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.unmountBucket.mockResolvedValue(undefined);
    mockSandbox.cleanupMountDirectory.mockResolvedValue(undefined);
  });

  it('unmounts a bucket and runs semantic cleanup operation', async () => {
    const res = await unmountRequest({ mountPath: '/mnt/data' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockSandbox.unmountBucket).toHaveBeenCalledWith('/mnt/data');
    expect(mockSandbox.cleanupMountDirectory).toHaveBeenCalledWith('/mnt/data');
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('succeeds even if cleanup operation fails', async () => {
    mockSandbox.cleanupMountDirectory.mockRejectedValueOnce(new Error('cleanup failed'));
    const res = await unmountRequest({ mountPath: '/mnt/data' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockSandbox.unmountBucket).toHaveBeenCalledWith('/mnt/data');
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('rejects missing mountPath', async () => {
    const res = await unmountRequest({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('mountPath');
  });

  it('rejects relative mountPath', async () => {
    const res = await unmountRequest({ mountPath: 'mnt/data' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('absolute path');
  });

  it('rejects root path to prevent destructive cleanup', async () => {
    const res = await unmountRequest({ mountPath: '/' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('filesystem root');
    expect(mockSandbox.unmountBucket).not.toHaveBeenCalled();
    expect(mockSandbox.cleanupMountDirectory).not.toHaveBeenCalled();
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('rejects paths that normalize to root via traversal', async () => {
    const res = await unmountRequest({ mountPath: '/mnt/data/../..' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('filesystem root');
    expect(mockSandbox.unmountBucket).not.toHaveBeenCalled();
    expect(mockSandbox.cleanupMountDirectory).not.toHaveBeenCalled();
  });

  it('allows single-segment paths like /workspace', async () => {
    const res = await unmountRequest({ mountPath: '/workspace' });
    expect(res.status).toBe(200);
    expect(mockSandbox.unmountBucket).toHaveBeenCalledWith('/workspace');
    expect(mockSandbox.cleanupMountDirectory).toHaveBeenCalledWith('/workspace');
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('normalizes the path before passing to SDK cleanup', async () => {
    const res = await unmountRequest({ mountPath: '/mnt/data/../buckets/store' });
    expect(res.status).toBe(200);
    expect(mockSandbox.unmountBucket).toHaveBeenCalledWith('/mnt/buckets/store');
    expect(mockSandbox.cleanupMountDirectory).toHaveBeenCalledWith('/mnt/buckets/store');
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON body', async () => {
    const res = await app.request(
      `${BASE}/v1/sandbox/test/unmount`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json'
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid JSON');
  });

  it('returns 502 on SDK unmount error and does not attempt cleanup', async () => {
    mockSandbox.unmountBucket.mockRejectedValue(new Error('No active mount found'));
    const res = await unmountRequest({ mountPath: '/mnt/data' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('unmount_error');
    expect(body.error).toContain('No active mount found');

    expect(mockSandbox.cleanupMountDirectory).not.toHaveBeenCalled();
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });
});
