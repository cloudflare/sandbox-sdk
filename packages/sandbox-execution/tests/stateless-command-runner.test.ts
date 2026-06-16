import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatelessCommandRunner } from '../src';

describe('StatelessCommandRunner', () => {
  const runner = new StatelessCommandRunner();
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
    );
    tempDirs = [];
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sandbox-execution-'));
    tempDirs.push(dir);
    return dir;
  }

  it('captures stdout, stderr, and exit code', async () => {
    const result = await runner.exec(
      'printf stdout; printf stderr >&2; exit 7'
    );

    expect(result.stdout).toBe('stdout');
    expect(result.stderr).toBe('stderr');
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('uses cwd for one command without leaking state', async () => {
    const dir = await tempDir();

    const first = await runner.exec('pwd', { cwd: dir });
    const second = await runner.exec('pwd');

    expect(first.stdout.trim()).toBe(dir);
    expect(second.stdout.trim()).not.toBe(dir);
  });

  it('uses env for one command without leaking state', async () => {
    const first = await runner.exec('printf "$SANDBOX_EXECUTION_TEST"', {
      env: { SANDBOX_EXECUTION_TEST: 'from-call' }
    });
    const second = await runner.exec('printf "$SANDBOX_EXECUTION_TEST"');

    expect(first.stdout).toBe('from-call');
    expect(second.stdout).toBe('');
  });

  it('does not preserve shell state between commands', async () => {
    await runner.exec('cd /tmp && export SANDBOX_EXECUTION_STATE=leaked');

    const result = await runner.exec(
      'printf "%s:%s" "$PWD" "$SANDBOX_EXECUTION_STATE"'
    );

    expect(result.stdout).not.toBe('/tmp:leaked');
    expect(result.stdout).toBe('/workspace:');
  });

  it('times out a command and returns partial output', async () => {
    const result = await runner.exec('printf before; sleep 1; printf after', {
      timeoutMs: 50
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe('before');
    expect(result.stderr).toContain('Command timed out after 50ms');
    expect(result.timedOut).toBe(true);
  });
});
