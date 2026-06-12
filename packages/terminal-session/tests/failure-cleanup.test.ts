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
});
