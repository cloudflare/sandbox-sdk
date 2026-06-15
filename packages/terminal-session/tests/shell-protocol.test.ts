import { describe, expect, it } from 'bun:test';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TerminalSession } from '../src/index';

async function listTerminalSessionDirs(): Promise<Set<string>> {
  const entries = await readdir('/tmp');
  return new Set(
    entries
      .filter((entry) => entry.startsWith('terminal-session-'))
      .map((entry) => join('/tmp', entry))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe('TerminalSession shell protocol', () => {
  it('runs prompt-bound commands with clean terminal transcript and persistent shell state', async () => {
    await using session = await TerminalSession.create();

    const first = await session.exec('echo hi');
    const second = await session.exec('cd /tmp && pwd');
    const third = await session.exec('pwd');

    expect(first.exitCode).toBe(0);
    expect(first.transcript).toContain('echo hi');
    expect(first.transcript).toContain('hi');
    expect(first.transcript).not.toContain('EXEC_DONE');
    expect(first.transcript).not.toContain('TERMINAL_SESSION');

    expect(second.exitCode).toBe(0);
    expect(second.transcript).toContain('/tmp');
    expect(third.exitCode).toBe(0);
    expect(third.transcript).toContain('/tmp');
  });

  it('starts bash with job control available', async () => {
    await using session = await TerminalSession.create();

    const result = await session.exec('set -o | grep monitor');

    expect(result.exitCode).toBe(0);
    expect(result.transcript).toMatch(/^monitor\s+on$/m);
    expect(result.transcript).not.toContain('no job control');
  });

  it('does not create a filesystem FIFO for command delivery', async () => {
    const before = await listTerminalSessionDirs();
    await using _session = await TerminalSession.create();
    const after = await listTerminalSessionDirs();
    const createdDirs = [...after].filter((dir) => !before.has(dir));

    expect(createdDirs.length).toBe(1);
    await expect(pathExists(join(createdDirs[0], 'commands'))).resolves.toBe(
      false
    );
  });
});
