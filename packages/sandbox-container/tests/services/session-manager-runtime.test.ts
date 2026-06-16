import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandSession } from '@repo/sandbox-execution';
import { createNoOpLogger } from '@repo/shared';
import { SessionManager } from '../../src/services/session-manager';

describe('SessionManager runtime integration', () => {
  let sessionManager: SessionManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-runtime-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    sessionManager = new SessionManager(createNoOpLogger());
  });

  afterEach(async () => {
    await sessionManager.destroy();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('creates persistent exec sessions through the execution runtime', async () => {
    const createSpy = vi.spyOn(CommandSession, 'create');

    const setResult = await sessionManager.executeInSession(
      'runtime-session',
      'export SESSION_RUNTIME_VALUE=from-runtime',
      { cwd: testDir }
    );
    const readResult = await sessionManager.executeInSession(
      'runtime-session',
      'printf "$SESSION_RUNTIME_VALUE"',
      { cwd: testDir }
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: testDir })
    );
    expect(setResult.success).toBe(true);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.data.stdout).toBe('from-runtime');
    }
  });

  it('streams background session processes through the execution runtime', async () => {
    const startProcessSpy = vi.spyOn(CommandSession.prototype, 'startProcess');
    const events: Array<{
      type: string;
      data?: string;
      exitCode?: number;
      pid?: number;
    }> = [];

    const setupResult = await sessionManager.executeInSession(
      'runtime-process-session',
      String.raw`export RUNTIME_PROCESS_VALUE=from-session
alias say_runtime_process='printf "alias:%s\n" "$RUNTIME_PROCESS_VALUE"'`,
      { cwd: testDir }
    );
    expect(setupResult.success).toBe(true);

    const streamResult = await sessionManager.executeStreamInSession(
      'runtime-process-session',
      String.raw`printf "out:%s\n" "$RUNTIME_PROCESS_VALUE"
say_runtime_process
printf "err:%s\n" "$RUNTIME_PROCESS_VALUE" >&2
sleep 0.2
printf "done\n"`,
      async (event) => {
        events.push({
          type: event.type,
          data: event.data,
          exitCode: event.exitCode,
          pid: event.pid
        });
      },
      { cwd: testDir },
      'runtime-bg-command',
      { background: true }
    );

    expect(streamResult.success).toBe(true);
    expect(startProcessSpy).toHaveBeenCalled();

    const concurrentExecResult = await sessionManager.executeInSession(
      'runtime-process-session',
      'printf "still-usable:%s" "$RUNTIME_PROCESS_VALUE"',
      { cwd: testDir }
    );
    expect(concurrentExecResult.success).toBe(true);
    if (concurrentExecResult.success) {
      expect(concurrentExecResult.data.stdout).toBe(
        'still-usable:from-session'
      );
    }

    if (streamResult.success) {
      await streamResult.data.continueStreaming;
    }

    expect(events[0]).toMatchObject({ type: 'start' });
    expect(events[0].pid).toBeGreaterThan(0);
    expect(
      events
        .filter((event) => event.type === 'stdout')
        .map((event) => event.data)
        .join('')
    ).toBe('out:from-session\nalias:from-session\ndone\n');
    expect(
      events
        .filter((event) => event.type === 'stderr')
        .map((event) => event.data)
        .join('')
    ).toBe('err:from-session\n');
    expect(events.at(-1)).toMatchObject({ type: 'complete', exitCode: 0 });
  });

  it('kills runtime process startup before the process handle resolves', async () => {
    const sessionId = 'runtime-startup-kill-session';
    const commandId = 'runtime-startup-kill-command';
    const startProcessCalled = Promise.withResolvers<void>();
    const originalStartProcess = CommandSession.prototype.startProcess;
    vi.spyOn(CommandSession.prototype, 'startProcess').mockImplementation(
      function (
        this: CommandSession,
        command: Parameters<CommandSession['startProcess']>[0],
        options: Parameters<CommandSession['startProcess']>[1]
      ) {
        startProcessCalled.resolve();
        return Bun.sleep(100).then(() =>
          originalStartProcess.call(this, command, options)
        );
      }
    );

    const createResult = await sessionManager.executeInSession(
      sessionId,
      'printf "ready"',
      { cwd: testDir }
    );
    expect(createResult.success).toBe(true);

    const streamPromise = sessionManager.executeStreamInSession(
      sessionId,
      'printf "should-not-run"; sleep 10',
      async () => {},
      { cwd: testDir },
      commandId,
      { background: true }
    );
    await startProcessCalled.promise;

    const killResult = await sessionManager.killCommand(sessionId, commandId);

    expect(killResult.success).toBe(true);
    const streamResult = await streamPromise;
    expect(streamResult.success).toBe(true);
    if (streamResult.success) {
      await streamResult.data.continueStreaming;
    }
  });

  it('kills background session processes through the execution runtime', async () => {
    const events: Array<{ type: string; data?: string; exitCode?: number }> =
      [];
    const sawStartOutput = Promise.withResolvers<void>();

    const streamResult = await sessionManager.executeStreamInSession(
      'runtime-kill-session',
      String.raw`printf "started\n"; sleep 10`,
      async (event) => {
        events.push({
          type: event.type,
          data: event.data,
          exitCode: event.exitCode
        });
        if (event.type === 'stdout' && event.data?.includes('started')) {
          sawStartOutput.resolve();
        }
      },
      { cwd: testDir },
      'runtime-kill-command',
      { background: true }
    );

    expect(streamResult.success).toBe(true);
    await Promise.race([
      sawStartOutput.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error('Timed out waiting for runtime process output');
      })
    ]);

    const killResult = await sessionManager.killCommand(
      'runtime-kill-session',
      'runtime-kill-command'
    );
    expect(killResult.success).toBe(true);

    if (streamResult.success) {
      await streamResult.data.continueStreaming;
    }

    const afterKillResult = await sessionManager.executeInSession(
      'runtime-kill-session',
      'printf "after-kill"',
      { cwd: testDir }
    );

    expect(afterKillResult.success).toBe(true);
    if (afterKillResult.success) {
      expect(afterKillResult.data.stdout).toBe('after-kill');
    }
    expect(events.some((event) => event.type === 'stdout')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
    expect(events.at(-1)?.exitCode).not.toBe(0);
  });
});
