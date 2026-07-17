import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, createSSEFileStream, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();
const archivePath = '/tmp/sandbox-workspace-test.tar';

function pullDrivenSSEStream(content: string, onPull: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const data = btoa(content);
  let sent = false;

  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull();
        if (sent) return;
        sent = true;
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'metadata',
              mimeType: 'application/octet-stream',
              size: content.length,
              isBinary: true,
              encoding: 'base64'
            })}\n\ndata: ${JSON.stringify({ type: 'chunk', data })}\n\ndata: ${JSON.stringify({ type: 'complete' })}\n\n`
          )
        );
        controller.close();
      }
    },
    { highWaterMark: 0 }
  );
}

function openSSEStream(content: string, onCancel: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;

  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'metadata',
              mimeType: 'application/octet-stream',
              size: content.length,
              isBinary: true,
              encoding: 'base64'
            })}\n\ndata: ${JSON.stringify({ type: 'chunk', data: btoa(content) })}\n\n`
          )
        );
      },
      cancel() {
        onCancel();
      }
    },
    { highWaterMark: 0 }
  );
}

describe('POST /v1/sandbox/:id/persist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.createWorkspaceArchive.mockResolvedValue(archivePath);
    mockSandbox.readFileStream.mockResolvedValue(createSSEFileStream('tar-data', { isBinary: true }));
  });

  it('cleans the semantic workspace archive after response consumption', async () => {
    const res = await app.request(sandboxUrl('test', 'persist'), { method: 'POST' }, env);

    expect(res.status).toBe(200);
    expect(mockSandbox.createWorkspaceArchive).toHaveBeenCalledWith({
      root: '/workspace',
      excludes: []
    });
    expect(mockSandbox.readFileStream).toHaveBeenCalledWith(archivePath);
    expect(mockSandbox.cleanupWorkspaceArchive).not.toHaveBeenCalled();

    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('tar-data');
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledOnce();
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledWith(archivePath);
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('does not read archive bytes before response consumption', async () => {
    const onPull = vi.fn();
    mockSandbox.readFileStream.mockResolvedValue(pullDrivenSSEStream('tar-data', onPull));

    const res = await app.request(sandboxUrl('test', 'persist'), { method: 'POST' }, env);

    expect(res.status).toBe(200);
    expect(onPull).not.toHaveBeenCalled();
    await res.arrayBuffer();
    expect(onPull).toHaveBeenCalled();
  });

  it('cancels the source before cleaning a cancelled response', async () => {
    const events: string[] = [];
    mockSandbox.readFileStream.mockResolvedValue(openSSEStream('tar-data', () => events.push('source-cancel')));
    mockSandbox.cleanupWorkspaceArchive.mockImplementation(async () => {
      events.push('cleanup');
    });

    const res = await app.request(sandboxUrl('test', 'persist'), { method: 'POST' }, env);
    const reader = res.body!.getReader();

    expect((await reader.read()).value).toEqual(new TextEncoder().encode('tar-data'));
    await reader.cancel();

    expect(events).toEqual(['source-cancel', 'cleanup']);
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledOnce();
  });

  it('cleans the created archive when stream acquisition fails', async () => {
    mockSandbox.readFileStream.mockRejectedValue(new Error('read failed'));

    const res = await app.request(sandboxUrl('test', 'persist'), { method: 'POST' }, env);

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('read failed');
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledOnce();
    expect(mockSandbox.cleanupWorkspaceArchive).toHaveBeenCalledWith(archivePath);
  });

  it('preserves acquisition errors when cleanup also fails', async () => {
    mockSandbox.readFileStream.mockRejectedValue(new Error('read failed'));
    mockSandbox.cleanupWorkspaceArchive.mockRejectedValue(new Error('cleanup failed'));

    const res = await app.request(sandboxUrl('test', 'persist'), { method: 'POST' }, env);

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('read failed');
  });

  it('does not clean when archive creation fails', async () => {
    mockSandbox.createWorkspaceArchive.mockRejectedValue(new Error('create failed'));

    const res = await app.request(sandboxUrl('test', 'persist'), { method: 'POST' }, env);

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('create failed');
    expect(mockSandbox.cleanupWorkspaceArchive).not.toHaveBeenCalled();
  });

  it('passes validated excludes to workspace archive creation', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'excludes=__pycache__,.venv'), { method: 'POST' }, env);

    expect(res.status).toBe(200);
    expect(mockSandbox.createWorkspaceArchive).toHaveBeenCalledWith({
      root: '/workspace',
      excludes: ['__pycache__', '.venv']
    });
    expect(mockSandbox.exec).not.toHaveBeenCalled();
    await res.body?.cancel();
  });

  it('rejects excludes containing ".." before SDK calls', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'excludes=../../etc'), { method: 'POST' }, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('exclude paths must not contain ".."');
    expect(mockSandbox.createWorkspaceArchive).not.toHaveBeenCalled();
    expect(mockSandbox.exec).not.toHaveBeenCalled();
  });

  it('ignores a root query parameter', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'root=/etc'), { method: 'POST' }, env);

    expect(res.status).toBe(200);
    expect(mockSandbox.createWorkspaceArchive).toHaveBeenCalledWith({
      root: '/workspace',
      excludes: []
    });
    await res.body?.cancel();
  });
});
