import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function mountRequest(body: unknown) {
  return app.request(
    `${BASE}/v1/sandbox/test/mount`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    env
  );
}

describe('POST /v1/sandbox/:id/mount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.mountBucket.mockResolvedValue(undefined);
  });

  it('mounts a bucket with endpoint only', async () => {
    const res = await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: { endpoint: 'https://acct.r2.cloudflarestorage.com' }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(mockSandbox.mountBucket).toHaveBeenCalledWith('my-bucket', '/mnt/data', {
      endpoint: 'https://acct.r2.cloudflarestorage.com'
    });
  });

  it('passes explicit credentials to the SDK', async () => {
    const res = await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: {
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        credentials: {
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET'
        }
      }
    });
    expect(res.status).toBe(200);

    expect(mockSandbox.mountBucket).toHaveBeenCalledWith('my-bucket', '/mnt/data', {
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' }
    });
  });

  it('omits credentials when not provided', async () => {
    await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: { endpoint: 'https://s3.us-west-2.amazonaws.com' }
    });

    const call = mockSandbox.mountBucket.mock.calls[0];
    expect(call[2]).toEqual({ endpoint: 'https://s3.us-west-2.amazonaws.com' });
    expect(call[2]).not.toHaveProperty('credentials');
  });

  it('passes prefix option', async () => {
    await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: {
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        prefix: '/uploads/'
      }
    });

    expect(mockSandbox.mountBucket).toHaveBeenCalledWith('my-bucket', '/mnt/data', {
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      prefix: '/uploads/'
    });
  });

  it('passes readOnly option', async () => {
    await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: {
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        readOnly: true
      }
    });

    expect(mockSandbox.mountBucket).toHaveBeenCalledWith('my-bucket', '/mnt/data', {
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      readOnly: true
    });
  });

  it('rejects missing bucket', async () => {
    const res = await mountRequest({
      mountPath: '/mnt/data',
      options: { endpoint: 'https://acct.r2.cloudflarestorage.com' }
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('bucket');
  });

  it('rejects missing mountPath', async () => {
    const res = await mountRequest({
      bucket: 'my-bucket',
      options: { endpoint: 'https://acct.r2.cloudflarestorage.com' }
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('mountPath');
  });

  it('rejects relative mountPath', async () => {
    const res = await mountRequest({
      bucket: 'my-bucket',
      mountPath: 'mnt/data',
      options: { endpoint: 'https://acct.r2.cloudflarestorage.com' }
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('absolute path');
  });

  it('rejects missing options', async () => {
    const res = await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data'
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('options');
  });

  it('rejects missing endpoint', async () => {
    const res = await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: {}
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('endpoint');
  });

  it('rejects invalid JSON body', async () => {
    const res = await app.request(
      `${BASE}/v1/sandbox/test/mount`,
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

  it('returns 502 on SDK mount error', async () => {
    mockSandbox.mountBucket.mockRejectedValue(new Error('Mount path already in use'));
    const res = await mountRequest({
      bucket: 'my-bucket',
      mountPath: '/mnt/data',
      options: { endpoint: 'https://acct.r2.cloudflarestorage.com' }
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('mount_error');
    expect(body.error).toContain('Mount path already in use');
  });
});
