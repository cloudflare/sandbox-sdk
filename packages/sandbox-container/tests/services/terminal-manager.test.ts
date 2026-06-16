import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger } from '@repo/shared';
import { TerminalManager } from '../../src/services/terminal-manager';

describe('TerminalManager', () => {
  let terminalManager: TerminalManager;
  let testDir: string | undefined;

  afterEach(async () => {
    await terminalManager?.destroyAll();
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  async function collectPtyOutput(
    pty: Awaited<ReturnType<TerminalManager['getOrCreateTerminal']>>['pty'],
    command: string,
    waitMs = 500
  ): Promise<string> {
    const chunks: Uint8Array[] = [];
    const disposable = pty.onData((data) => chunks.push(data));
    pty.write(command);
    await Bun.sleep(waitMs);
    disposable.dispose();
    return Buffer.concat(chunks).toString('utf8');
  }

  it('creates terminal handles from explicit terminal options', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-handle-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const handle = await terminalManager.getOrCreateTerminal({
      id: 'handle-terminal',
      cwd: testDir,
      env: { TERMINAL_MANAGER_VALUE: 'from-terminal' },
      pty: { shell: '/bin/bash' }
    });

    expect(handle.id).toBe('handle-terminal');
    expect(handle.pty).toBeDefined();

    const output = await collectPtyOutput(
      handle.pty,
      'printf "cwd:%s env:%s\\n" "$PWD" "$TERMINAL_MANAGER_VALUE"\n'
    );
    expect(output).toContain(
      `cwd:${await realpath(testDir)} env:from-terminal`
    );
  });

  it('caches terminal handles by terminal ID', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-cache-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const firstHandle = await terminalManager.getOrCreateTerminal({
      id: 'cache-terminal',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });
    const secondHandle = await terminalManager.getOrCreateTerminal({
      id: 'cache-terminal',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });

    expect(secondHandle).toBe(firstHandle);
    expect(terminalManager.getTerminal('cache-terminal')).toBe(firstHandle);
  });

  it('creates distinct terminals for different terminal IDs', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-distinct-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const firstHandle = await terminalManager.getOrCreateTerminal({
      id: 'terminal-a',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });
    const secondHandle = await terminalManager.getOrCreateTerminal({
      id: 'terminal-b',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });

    expect(firstHandle.id).toBe('terminal-a');
    expect(secondHandle.id).toBe('terminal-b');
    expect(secondHandle.pty).not.toBe(firstHandle.pty);
  });

  it('destroys one terminal resource without destroying siblings', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-siblings-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const firstHandle = await terminalManager.getOrCreateTerminal({
      id: 'terminal-a',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });
    const secondHandle = await terminalManager.getOrCreateTerminal({
      id: 'terminal-b',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });

    await terminalManager.destroyTerminal('terminal-a');

    expect(terminalManager.getTerminal('terminal-a')).toBeUndefined();
    expect(terminalManager.getTerminal('terminal-b')).toBe(secondHandle);
    expect(() => firstHandle.pty.write('echo old\n')).toThrow();
    expect(() => secondHandle.pty.write('echo still-open\n')).not.toThrow();
  });

  it('destroys and clears a terminal by terminal ID', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-destroy-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const firstHandle = await terminalManager.getOrCreateTerminal({
      id: 'destroy-terminal',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });
    await terminalManager.destroyTerminal('destroy-terminal');
    const secondHandle = await terminalManager.getOrCreateTerminal({
      id: 'destroy-terminal',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });

    expect(secondHandle).not.toBe(firstHandle);
    expect(() => firstHandle.pty.write('echo old\n')).toThrow();
  });
});
