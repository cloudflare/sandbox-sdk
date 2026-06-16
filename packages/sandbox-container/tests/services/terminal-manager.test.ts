import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger } from '@repo/shared';
import { TerminalManager } from '../../src/services/terminal-manager';
import type { RawExecResult } from '../../src/session-types';

class FakeSession {
  constructor(private readonly cwd: string) {}

  async exec(command: string): Promise<RawExecResult> {
    if (command.startsWith('env -0 > ')) {
      const path = command.match(/'([^']+)'/)?.[1];
      if (!path) {
        throw new Error(`Could not parse env target from ${command}`);
      }
      await Bun.write(path, 'TERM_MANAGER_TEST=1\0PATH=/usr/bin\0');
      return this.result(command, '', '', 0);
    }

    if (command === 'pwd') {
      return this.result(command, `${this.cwd}\n`, '', 0);
    }

    return this.result(command, '', `Unexpected command: ${command}`, 1);
  }

  private result(
    command: string,
    stdout: string,
    stderr: string,
    exitCode: number
  ): RawExecResult {
    return {
      command,
      stdout,
      stderr,
      exitCode,
      duration: 0,
      timestamp: new Date().toISOString()
    };
  }
}

describe('TerminalManager', () => {
  let terminalManager: TerminalManager;
  let testDir: string | undefined;

  afterEach(async () => {
    await terminalManager?.destroyAll();
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('caches PTYs by session ID', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-cache-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const firstPty = await terminalManager.getPty('cache-session', session, {
      shell: '/bin/bash'
    });
    const secondPty = await terminalManager.getPty('cache-session', session, {
      shell: '/bin/bash'
    });

    expect(secondPty).toBe(firstPty);
  });

  it('destroys and clears a terminal by session ID', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-destroy-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const firstPty = await terminalManager.getPty('destroy-session', session, {
      shell: '/bin/bash'
    });
    await terminalManager.destroyTerminal('destroy-session');
    const secondPty = await terminalManager.getPty('destroy-session', session, {
      shell: '/bin/bash'
    });

    expect(secondPty).not.toBe(firstPty);
    expect(() => firstPty.write('echo old\n')).toThrow();
  });
});
