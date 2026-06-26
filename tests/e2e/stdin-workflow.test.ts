import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTestSandbox,
  createTestSandbox,
  type TestSandbox
} from './helpers/global-sandbox';

/**
 * E2E coverage for `SandboxExecOptions.stdin`.
 *
 * Validates the full pipe: SDK `stdin` option -> control-plane RPC ->
 * container-side per-command stdin FIFO -> spawned process's standard
 * input. The test-worker's `/api/execute` endpoint accepts an optional
 * `stdin` string in the body and forwards it through `sandbox.exec()`.
 *
 * Run against a real container (Docker / Cloudflare Containers).
 */
describe('stdin workflow', () => {
  let sandbox: TestSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createTestSandbox();
  }, 120000);

  afterAll(async () => {
    await cleanupTestSandbox(sandbox);
    sandbox = null;
  }, 120000);

  /**
   * Helper: POST /api/execute with stdin and return the unified
   * `SandboxExecOutput` shape (`stdout`, `stderr`, `exitCode`, etc.).
   */
  async function execWithStdin(
    command: string,
    stdin: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!sandbox) throw new Error('sandbox not initialised');
    const response = await fetch(`${sandbox.workerUrl}/api/execute`, {
      method: 'POST',
      headers: sandbox.headers(),
      body: JSON.stringify({ command, stdin })
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
  }

  it('pipes a string stdin into `cat`', async () => {
    // The simplest end-to-end check: `cat` echoes whatever it reads from
    // stdin to stdout. If the FIFO plumbing is intact the command's
    // stdout exactly matches the input.
    const result = await execWithStdin('cat', 'hello from stdin\n');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from stdin\n');
  });

  it('honours multi-line stdin via `wc -l`', async () => {
    // `wc -l` counts newlines; verifies that successive bytes (not just
    // a single read) flow through the FIFO and into the command.
    const input = ['alpha', 'beta', 'gamma', 'delta', ''].join('\n');
    const result = await execWithStdin('wc -l', input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('4');
  });

  it('closes stdin with EOF so `read` terminates', async () => {
    // A loop doing `while read line; do ...; done` must observe EOF when
    // the stream closes, otherwise the test would hang indefinitely.
    const result = await execWithStdin(
      'while IFS= read -r line; do echo "got: $line"; done',
      'one\ntwo\nthree\n'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('got: one\ngot: two\ngot: three\n');
  });

  it('respects the same scoped env layering as a no-stdin exec', async () => {
    // Layered with an env var to confirm the stdin path doesn't bypass
    // the rest of `SandboxExecOptions` handling.
    const sandboxRef = sandbox!;
    const response = await fetch(`${sandboxRef.workerUrl}/api/execute`, {
      method: 'POST',
      headers: sandboxRef.headers(),
      body: JSON.stringify({
        command: 'echo "$GREETING $(cat)"',
        stdin: 'world',
        env: { GREETING: 'hello' }
      })
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });
});
