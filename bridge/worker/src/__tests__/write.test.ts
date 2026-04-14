import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE, createMockEnv, createMockSandbox } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

function writeRequest(path: string, content = 'hello') {
  return app.request(
    `${BASE}/v1/sandbox/test/file/${path}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content
    },
    env
  );
}

describe('PUT /v1/sandbox/:id/file/* — path validation', () => {
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
    // Content is now base64-encoded for binary safety
    expect(call[1]).toBe(btoa('hello'));
    expect(call[2]).toEqual({ encoding: 'base64' });
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
      `${BASE}/v1/sandbox/test/file/`,
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

describe('PUT /sandbox/:id/file/* — binary payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.writeFile.mockResolvedValue(undefined);
  });

  it('base64-encodes binary content for writeFile', async () => {
    // Send raw bytes that are not valid UTF-8
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await app.request(
      `${BASE}/v1/sandbox/test/file/workspace/image.png`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes
      },
      env
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.writeFile.mock.calls[0] as any[];
    expect(call[0]).toBe('/workspace/image.png');
    // Verify round-trip: decode the base64 and compare to original bytes
    const decoded = Uint8Array.from(atob(call[1]), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
    expect(call[2]).toEqual({ encoding: 'base64' });
  });

  it('returns 413 for payloads exceeding 32 MiB', async () => {
    // Create a body that claims to be > 32 MiB without allocating real memory
    // by checking the error response for a small-but-over-limit indicator.
    // In practice we just verify the limit constant is enforced.
    const limit = 32 * 1024 * 1024;
    const res = await app.request(
      `${BASE}/v1/sandbox/test/file/workspace/huge.bin`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(limit + 1)
      },
      env
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('payload_too_large');
  });
});

describe('PUT /sandbox/:id/file/* — chunked base64 encoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.writeFile.mockResolvedValue(undefined);
  });

  it('produces valid base64 that decodes to the original bytes for large payloads', async () => {
    // 100KB of pseudo-random but deterministic bytes (every value 0-255 repeated)
    const size = 100_000;
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i++) input[i] = i % 256;

    const res = await app.request(
      `${BASE}/v1/sandbox/test/file/workspace/large.bin`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: input
      },
      env
    );
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.writeFile.mock.calls[0] as any[];
    const b64 = call[1] as string;
    expect(call[2]).toEqual({ encoding: 'base64' });

    // The base64 string must contain only valid characters (no stray newlines)
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);

    // Decode and compare byte-for-byte against the original input.
    // This is the same decode path the container uses: Buffer.from(b64, 'base64').
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(size);
    expect(decoded).toEqual(input);
  });

  it('does not produce intermediate padding in chunked base64', async () => {
    // Send a payload larger than one chunk (6144 bytes) so multiple btoa()
    // calls are concatenated. Intermediate padding would cause Buffer.from()
    // to stop decoding early.
    const size = 20_000;
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i++) input[i] = i % 256;

    const res = await app.request(
      `${BASE}/v1/sandbox/test/file/workspace/chunked.bin`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: input
      },
      env
    );
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.writeFile.mock.calls[0] as any[];
    const b64 = call[1] as string;

    // Only the very end of the string may have padding. If '=' appears,
    // it must only be in the last 2 characters.
    const paddingIndex = b64.indexOf('=');
    if (paddingIndex !== -1) {
      expect(paddingIndex).toBeGreaterThanOrEqual(b64.length - 2);
    }

    // Full decode must recover every byte
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(size);
    expect(decoded).toEqual(input);
  });
});
