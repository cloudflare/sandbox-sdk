import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function makeTarBody(): Uint8Array {
  return new Uint8Array(1024).fill(0x41);
}

function hydrateRequest(query?: string): Promise<Response> {
  return app.request(
    sandboxUrl('test', 'hydrate', query),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: makeTarBody()
    },
    env
  );
}

function writtenArchivePath(): string {
  return mockSandbox.writeFile.mock.calls[0][0];
}

describe('POST /v1/sandbox/:id/hydrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.writeFile.mockResolvedValue(undefined);
    mockSandbox.extractWorkspaceArchive.mockResolvedValue(undefined);
    mockSandbox.cleanupWorkspaceArchive.mockResolvedValue(undefined);
  });

  it('cleans the uploaded archive after semantic extraction', async () => {
    const res = await hydrateRequest();

    expect(res.status).toBe(200);
    expect(writtenArchivePath()).toMatch(/^\/tmp\/sandbox-hydrate-\d+-[0-9a-f-]{36}\.tar$/);
    expect(mockSandbox.writeFile.mock.calls[0][2]).toEqual({
      encoding: 'base64'
    });
    expect(mockSandbox.extractWorkspaceArchive.mock.calls[0][0]).toEqual({
      root: '/workspace',
      archivePath: writtenArchivePath()
    });
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledOnce();
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledWith(writtenArchivePath());
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('ignores a root query parameter', async () => {
    const res = await hydrateRequest('root=/etc');

    expect(res.status).toBe(200);
    expect(mockSandbox.extractWorkspaceArchive.mock.calls[0][0].root).toBe('/workspace');
  });

  it('cleans the uploaded archive when writing fails', async () => {
    mockSandbox.writeFile.mockRejectedValue(new Error('write failed'));

    const res = await hydrateRequest();

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('write failed');
    expect(mockSandbox.extractWorkspaceArchive).not.toHaveBeenCalled();
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledOnce();
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledWith(writtenArchivePath());
  });

  it('cleans the uploaded archive when extraction fails', async () => {
    mockSandbox.extractWorkspaceArchive.mockRejectedValue(new Error('extract failed'));

    const res = await hydrateRequest();

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('extract failed');
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledOnce();
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledWith(writtenArchivePath());
  });

  it('does not replace successful extraction when cleanup fails', async () => {
    mockSandbox.cleanupWorkspaceArchive.mockRejectedValue(new Error('cleanup failed'));

    const res = await hydrateRequest();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not replace write errors when cleanup fails', async () => {
    mockSandbox.writeFile.mockRejectedValue(new Error('write failed'));
    mockSandbox.cleanupWorkspaceArchive.mockRejectedValue(new Error('cleanup failed'));

    const res = await hydrateRequest();

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('write failed');
  });

  it('does not replace extraction errors when cleanup fails', async () => {
    mockSandbox.extractWorkspaceArchive.mockRejectedValue(new Error('extract failed'));
    mockSandbox.cleanupWorkspaceArchive.mockRejectedValue(new Error('cleanup failed'));

    const res = await hydrateRequest();

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('extract failed');
  });

  it('rejects an empty body without creating a temporary archive', async () => {
    const res = await app.request(
      sandboxUrl('test', 'hydrate'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(0)
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Empty tar payload');
    expect(mockSandbox.writeFile).not.toHaveBeenCalled();
    expect(mockSandbox.cleanupWorkspaceArchive).not.toHaveBeenCalled();
  });

  it('rejects an oversized body without creating a temporary archive', async () => {
    const bigBody = new Uint8Array(32 * 1024 * 1024 + 1);
    const res = await app.request(
      sandboxUrl('test', 'hydrate'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bigBody
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('tar payload too large');
    expect(mockSandbox.writeFile).not.toHaveBeenCalled();
    expect(mockSandbox.cleanupWorkspaceArchive).not.toHaveBeenCalled();
  });
});
