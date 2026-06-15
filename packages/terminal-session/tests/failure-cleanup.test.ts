import { describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TerminalSession } from '../src/index';

async function listTerminalSessionArtifacts(): Promise<string[]> {
  const entries = await readdir('/tmp');
  return entries
    .filter((entry) => entry.startsWith('terminal-session-'))
    .sort();
}

describe('TerminalSession failure cleanup', () => {
  it('allows a create-and-close subprocess to exit cleanly', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        'import { TerminalSession } from "./src/index.ts"; const session = await TerminalSession.create(); await session.close();'
      ],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe'
      }
    );

    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(3_000).then(() => {
        proc.kill('SIGKILL');
        throw new Error('create-and-close subprocess did not exit');
      })
    ]);

    expect(exitCode).toBe(0);
  });

  it('closes command-channel file descriptors on session close', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        [
          'import { readdir } from "node:fs/promises";',
          'import { TerminalSession } from "./src/index.ts";',
          'const countFDs = async () => (await readdir("/proc/self/fd")).length;',
          'const before = await countFDs();',
          'const session = await TerminalSession.create();',
          'await session.close();',
          'const after = await countFDs();',
          'if (after > before) {',
          '  console.error(JSON.stringify({ before, after }));',
          '  process.exit(1);',
          '}'
        ].join(' ')
      ],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe'
      }
    );

    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(3_000).then(() => {
        proc.kill('SIGKILL');
        throw new Error('fd cleanup subprocess did not exit');
      })
    ]);

    expect(await proc.stderr.text()).toBe('');
    expect(exitCode).toBe(0);
  });

  it('removes generated temp files when creation fails after temp files are created', async () => {
    const missingCwd = join(
      '/tmp',
      `missing-terminal-session-cwd-${crypto.randomUUID()}`
    );
    const before = await listTerminalSessionArtifacts();

    await expect(TerminalSession.create({ cwd: missingCwd })).rejects.toThrow();

    expect(await listTerminalSessionArtifacts()).toEqual(before);
  });

  it('fails pending and future exec calls clearly after the shell exits', async () => {
    const session = await TerminalSession.create();

    await expect(session.exec('exit', { timeoutMs: 500 })).rejects.toThrow(
      /exited/
    );
    await expect(
      session.exec('echo after-exit', { timeoutMs: 500 })
    ).rejects.toThrow(/exited|closed/);

    await session.close();
  });

  it('treats exec timeout as fatal for future commands', async () => {
    const session = await TerminalSession.create();

    await expect(
      session.exec('sleep 2; echo late', { timeoutMs: 50 })
    ).rejects.toThrow(/Timed out/);

    const start = performance.now();
    await expect(
      session.exec('echo after-timeout', { timeoutMs: 1_000 })
    ).rejects.toThrow(/Timed out|failed|closed/i);
    expect(performance.now() - start).toBeLessThan(100);

    await session.close();
  });
});
