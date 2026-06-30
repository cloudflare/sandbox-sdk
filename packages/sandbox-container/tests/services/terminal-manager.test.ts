import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger } from '@repo/shared';
import type { Pty } from '../../src/pty';
import type { CreateTerminalOptions } from '../../src/services/terminal-manager';
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

  it('coalesces concurrent terminal creation for the same terminal ID', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-concurrent-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const [firstHandle, secondHandle] = await Promise.all([
      terminalManager.getOrCreateTerminal({
        id: 'concurrent-terminal',
        cwd: testDir,
        pty: { shell: '/bin/bash' }
      }),
      terminalManager.getOrCreateTerminal({
        id: 'concurrent-terminal',
        cwd: testDir,
        pty: { shell: '/bin/bash' }
      })
    ]);

    expect(secondHandle).toBe(firstHandle);
    expect(terminalManager.getTerminal('concurrent-terminal')).toBe(
      firstHandle
    );
  });

  it('evicts a terminal when its shell exits naturally', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-exit-'));
    terminalManager = new TerminalManager(createNoOpLogger());

    const handle = await terminalManager.getOrCreateTerminal({
      id: 'exit-terminal',
      cwd: testDir,
      pty: { shell: '/bin/bash' }
    });

    handle.pty.write('exit\n');

    await Bun.sleep(300);

    expect(handle.pty.closed).toBe(true);
    expect(terminalManager.getTerminal('exit-terminal')).toBeUndefined();
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

  describe('destroy-during-creation race', () => {
    // Controllable TerminalManager that pauses creation until explicitly released.
    // ManagedTerminal is a structural type (no private fields) so returning a
    // compatible anonymous object satisfies the override without exporting the class.
    function createPausableManager() {
      let pauseResolve: (() => void) | null = null;
      let pausePromise: Promise<void> = Promise.resolve();
      const destroyedIds: string[] = [];

      class PausableTerminalManager extends TerminalManager {
        protected override createManagedTerminal(
          options: CreateTerminalOptions
        ) {
          return pausePromise.then(() => {
            const mockPty = {
              closed: false,
              destroy: async () => {
                destroyedIds.push(options.id);
                (mockPty as { closed: boolean }).closed = true;
              }
            } as unknown as Pty;
            return {
              handle: { id: options.id, pty: mockPty },
              destroy: async () => {
                await mockPty.destroy();
              }
            };
          });
        }
      }

      const manager = new PausableTerminalManager(createNoOpLogger());
      terminalManager = manager;

      return {
        manager,
        destroyedIds,
        pauseCreation() {
          pausePromise = new Promise<void>((resolve) => {
            pauseResolve = resolve;
          });
        },
        resumeCreation() {
          pauseResolve?.();
          pauseResolve = null;
          pausePromise = Promise.resolve();
        }
      };
    }

    it('destroyTerminal does not leak a terminal whose creation wins the race', async () => {
      const { manager, destroyedIds, pauseCreation, resumeCreation } =
        createPausableManager();

      pauseCreation();

      // Start creation — suspends inside createManagedTerminal
      const creationPromise = manager.getOrCreateTerminal({
        id: 'race-terminal'
      });

      // Destroy while creation is in-flight
      const destroyPromise = manager.destroyTerminal('race-terminal');

      // Allow creation to complete
      resumeCreation();

      await Promise.all([creationPromise, destroyPromise]);

      // Terminal must not be left in the map after destroy
      expect(manager.getTerminal('race-terminal')).toBeUndefined();
      // The PTY created during the race must have been destroyed
      expect(destroyedIds).toContain('race-terminal');
    });

    it('destroyAll does not leave live PTYs for in-flight creations', async () => {
      const { manager, destroyedIds, pauseCreation, resumeCreation } =
        createPausableManager();

      pauseCreation();

      // Start two creations — both suspend inside createManagedTerminal
      const creationA = manager.getOrCreateTerminal({ id: 'race-a' });
      const creationB = manager.getOrCreateTerminal({ id: 'race-b' });

      // destroyAll while both creations are in-flight
      const destroyAllPromise = manager.destroyAll();

      // Allow creations to complete
      resumeCreation();

      await Promise.all([creationA, creationB, destroyAllPromise]);

      // No terminals should survive the destroyAll
      expect(manager.getTerminal('race-a')).toBeUndefined();
      expect(manager.getTerminal('race-b')).toBeUndefined();
      // Both PTYs must have been destroyed
      expect(destroyedIds).toContain('race-a');
      expect(destroyedIds).toContain('race-b');
    });
  });
});
