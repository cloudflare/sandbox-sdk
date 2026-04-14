import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

// Build a minimal valid tar body (just some bytes — the mock won't actually
// extract it, we only care about the commands passed to sandbox.exec).
function makeTarBody(): Uint8Array {
  return new Uint8Array(1024).fill(0x41); // 1 KiB of 'A's
}

describe('POST /v1/sandbox/:id/hydrate — hardcoded root, shell-quoted commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    mockSandbox.writeFile.mockResolvedValue(undefined);
  });

  it('uses /workspace in mkdir and tar extract commands', async () => {
    const res = await app.request(
      sandboxUrl('test', 'hydrate'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: makeTarBody()
      },
      env
    );
    expect(res.status).toBe(200);

    // First exec call: mkdir -p /workspace
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mkdirCall = mockSandbox.exec.mock.calls[0] as any[];
    expect(mkdirCall[0] as string).toBe('mkdir -p /workspace');

    // Second exec call: tar xf ... -C /workspace && rm -f ...
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tarCall = mockSandbox.exec.mock.calls[1] as any[];
    const tarCmd = tarCall[0] as string;
    expect(tarCmd).toContain('-C /workspace');
    expect(tarCmd).toContain('rm -f');
  });

  it('ignores a root query parameter (always uses /workspace)', async () => {
    const res = await app.request(
      sandboxUrl('test', 'hydrate', 'root=/etc'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: makeTarBody()
      },
      env
    );
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mkdirCall = mockSandbox.exec.mock.calls[0] as any[];
    expect(mkdirCall[0] as string).toBe('mkdir -p /workspace');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tarCall = mockSandbox.exec.mock.calls[1] as any[];
    const tarCmd = tarCall[0] as string;
    expect(tarCmd).toContain('-C /workspace');
    expect(tarCmd).not.toContain('/etc');
  });

  it('rejects an empty body', async () => {
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
  });

  it('rejects an oversized body (>32 MiB)', async () => {
    const bigBody = new Uint8Array(32 * 1024 * 1024 + 1); // 32 MiB + 1 byte
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
  });

  it('shell-quotes tmpPath in tar extract command', async () => {
    const res = await app.request(
      sandboxUrl('test', 'hydrate'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: makeTarBody()
      },
      env
    );
    expect(res.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tarCall = mockSandbox.exec.mock.calls[1] as any[];
    const tarCmd = tarCall[0] as string;
    // The tmpPath follows the pattern /tmp/sandbox-hydrate-<timestamp>.tar
    expect(tarCmd).toMatch(
      /tar xf \/tmp\/sandbox-hydrate-\d+\.tar -C \/workspace && rm -f \/tmp\/sandbox-hydrate-\d+\.tar/
    );
  });
});
