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

  it('returns terminal handles with resource identity', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-handle-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const handle = await terminalManager.getTerminal(
      'handle-terminal',
      'handle-session',
      session,
      {
        shell: '/bin/bash'
      }
    );

    expect(handle.id).toBe('handle-terminal');
    expect(handle.sessionId).toBe('handle-session');
    expect(handle.pty).toBeDefined();
  });

  it('caches terminal handles by resource ID', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-cache-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const firstHandle = await terminalManager.getTerminal(
      'cache-terminal',
      'cache-session',
      session,
      {
        shell: '/bin/bash'
      }
    );
    const secondHandle = await terminalManager.getTerminal(
      'cache-terminal',
      'cache-session',
      session,
      {
        shell: '/bin/bash'
      }
    );

    expect(secondHandle).toBe(firstHandle);
    expect(secondHandle.pty).toBe(firstHandle.pty);
  });

  it('creates distinct terminals for different resource IDs on one session', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-distinct-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const firstHandle = await terminalManager.getTerminal(
      'terminal-a',
      'shared-session',
      session,
      {
        shell: '/bin/bash'
      }
    );
    const secondHandle = await terminalManager.getTerminal(
      'terminal-b',
      'shared-session',
      session,
      {
        shell: '/bin/bash'
      }
    );

    expect(firstHandle.id).toBe('terminal-a');
    expect(firstHandle.sessionId).toBe('shared-session');
    expect(secondHandle.id).toBe('terminal-b');
    expect(secondHandle.sessionId).toBe('shared-session');
    expect(secondHandle.pty).not.toBe(firstHandle.pty);
  });

  it('destroys one terminal resource without destroying siblings', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-siblings-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const firstHandle = await terminalManager.getTerminal(
      'terminal-a',
      'shared-session',
      session,
      {
        shell: '/bin/bash'
      }
    );
    const secondHandle = await terminalManager.getTerminal(
      'terminal-b',
      'shared-session',
      session,
      {
        shell: '/bin/bash'
      }
    );

    await terminalManager.destroyTerminal('terminal-a');

    expect(() => firstHandle.pty.write('echo old\n')).toThrow();
    expect(() => secondHandle.pty.write('echo still-open\n')).not.toThrow();
  });

  it('keeps getPty as a compatibility wrapper', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-pty-'));
    terminalManager = new TerminalManager(createNoOpLogger());
    const session = new FakeSession(testDir);

    const handle = await terminalManager.getTerminal(
      'pty-session',
      'pty-session',
      session,
      {
        shell: '/bin/bash'
      }
    );
    const pty = await terminalManager.getPty('pty-session', session, {
      shell: '/bin/bash'
    });

    expect(pty).toBe(handle.pty);
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
