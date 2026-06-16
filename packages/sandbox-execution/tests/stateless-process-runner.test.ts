import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatelessProcessRunner, type StdioChunk } from '../src';

describe('StatelessProcessRunner', () => {
  const runner = new StatelessProcessRunner();
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
    );
    tempDirs = [];
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sandbox-process-'));
    tempDirs.push(dir);
    return dir;
  }

  it('streams stdout before the process completes', async () => {
    const streamed: StdioChunk[] = [];
    const firstOutput = Promise.withResolvers<void>();

    const process = runner.start('printf before; sleep 1; printf after', {
      onOutput: (chunk) => {
        streamed.push(chunk);
        if (chunk.data.includes('before')) {
          firstOutput.resolve();
        }
      }
    });

    await Promise.race([
      firstOutput.promise,
      Bun.sleep(500).then(() => {
        throw new Error('Timed out waiting for live output');
      })
    ]);

    expect(streamed.map((chunk) => chunk.data).join('')).toContain('before');

    const result = await process.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('beforeafter');
    expect(result.stderr).toBe('');
    expect(result.output).toEqual(streamed);
  });

  it('captures stdout and stderr as filterable chunks', async () => {
    const process = runner.start(
      'printf out1; printf err1 >&2; printf out2; printf err2 >&2'
    );

    const result = await process.wait();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('out1out2');
    expect(result.stderr).toBe('err1err2');
    expect(result.output.map((chunk) => chunk.stream)).toContain('stdout');
    expect(result.output.map((chunk) => chunk.stream)).toContain('stderr');
    expect(result.output.map((chunk) => chunk.seq)).toEqual(
      result.output.map((_, index) => index)
    );
  });

  it('applies cwd and env to one process without leaking state', async () => {
    const dir = await tempDir();

    const first = await runner
      .start('printf "%s:%s" "$PWD" "$SANDBOX_PROCESS_ENV"', {
        cwd: dir,
        env: { SANDBOX_PROCESS_ENV: 'from-process' }
      })
      .wait();
    const second = await runner
      .start('printf "%s:%s" "$PWD" "$SANDBOX_PROCESS_ENV"')
      .wait();

    expect(first.stdout).toBe(`${dir}:from-process`);
    expect(second.stdout).toBe('/workspace:');
  });

  it('kills a running process tree and preserves partial output', async () => {
    const process = runner.start('printf before; sh -c "sleep 30"');

    await Bun.sleep(100);
    await process.kill();
    const result = await process.wait();

    expect(result.stdout).toBe('before');
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('times out a process tree and preserves partial output', async () => {
    const process = runner.start(
      'printf before; sh -c "sleep 30"; printf after',
      {
        timeoutMs: 50
      }
    );

    const result = await process.wait();

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe('before');
    expect(result.stderr).toContain('Command timed out after 50ms');
    expect(result.timedOut).toBe(true);
  });
});
