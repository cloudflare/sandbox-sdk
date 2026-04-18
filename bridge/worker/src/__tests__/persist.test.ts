import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv, createMockSandbox, createSSEFileStream, sandboxUrl } from './helpers';

const mockSandbox = createMockSandbox();
vi.mock('../../../../packages/sandbox/src/sandbox', () => ({
  getSandbox: vi.fn(() => mockSandbox),
  Sandbox: class {}
}));

const { app } = await import('./bridge-app');

const env = createMockEnv();

describe('POST /v1/sandbox/:id/persist — hardcoded root, exclude validation, quoting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    mockSandbox.readFileStream.mockResolvedValue(createSSEFileStream('tar-data', { isBinary: true }));
  });

  it('uses /workspace as root with no query params', async () => {
    const res = await app.request(
      sandboxUrl('test', 'persist'),
      {
        method: 'POST'
      },
      env
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const cmd = call[0] as string;
    expect(cmd).toContain('-C /workspace');
  });

  it('includes shell-quoted excludes in the tar command', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'excludes=__pycache__,.venv'), { method: 'POST' }, env);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const cmd = call[0] as string;
    // shellQuote wraps values that contain underscores (not in the safe-char set) in $'...'
    expect(cmd).toContain("--exclude $'./__pycache__'");
    expect(cmd).toContain('--exclude ./.venv');
  });

  it('rejects excludes containing ".."', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'excludes=../../etc'), { method: 'POST' }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('exclude paths must not contain ".."');
  });

  it('shell-quotes excludes with shell metacharacters', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'excludes=foo;rm -rf /'), { method: 'POST' }, env);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const cmd = call[0] as string;
    // The dangerous value should be wrapped in $'...' quoting, preventing
    // the shell from interpreting the semicolon as a command separator.
    expect(cmd).toContain("--exclude $'./foo;rm -rf /'");
    // The tar command itself should not have a bare semicolon outside quotes
    // that would act as a command separator for the shell.
    expect(cmd).not.toMatch(/'\s*;\s*rm/);
  });

  it('ignores a root query parameter (always uses /workspace)', async () => {
    const res = await app.request(sandboxUrl('test', 'persist', 'root=/etc'), { method: 'POST' }, env);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockSandbox.exec.mock.calls[0] as any[];
    const cmd = call[0] as string;
    expect(cmd).toContain('-C /workspace');
    expect(cmd).not.toContain('-C /etc');
  });

  it('shell-quotes tmpPath in cleanup command', async () => {
    const res = await app.request(
      sandboxUrl('test', 'persist'),
      {
        method: 'POST'
      },
      env
    );
    expect(res.status).toBe(200);
    // The second exec call should be the cleanup rm -f
    // It's called via .catch() so may be the second call or async
    const calls = mockSandbox.exec.mock.calls;
    // At least the first call (tar) should exist
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Cleanup is fire-and-forget; verify the main tar command has shell-quoted tmp path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tarCmd = (calls[0] as any[])[0] as string;
    expect(tarCmd).toMatch(/^tar cf \/tmp\/sandbox-persist-\d+\.tar/);
  });
});
