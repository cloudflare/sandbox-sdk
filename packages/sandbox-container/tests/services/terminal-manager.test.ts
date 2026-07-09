import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoOpLogger, ErrorCode } from '@repo/shared';
import {
  MAX_RETAINED_TERMINALS,
  TerminalManager
} from '../../src/services/terminal-manager';

describe('TerminalManager', () => {
  let terminalManager: TerminalManager;
  let testDir: string | undefined;

  afterEach(async () => {
    await terminalManager?.destroyAll();
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  function createManager(): TerminalManager {
    terminalManager = new TerminalManager(createNoOpLogger());
    return terminalManager;
  }

  async function nextData(
    stream: ReadableStream<
      Awaited<ReturnType<TerminalManager['output']>> extends ReadableStream<
        infer T
      >
        ? T
        : never
    >
  ): Promise<string> {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return '';
        if (result.value.type === 'data')
          return Buffer.from(result.value.data).toString('utf8');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  it('creates terminals with generated IDs and immutable snapshots', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'terminal-manager-create-'));
    const manager = createManager();
    const command: [string, string, string] = ['/bin/sh', '-lc', 'sleep 1'];

    const snapshot = await manager.create({
      command,
      cwd: testDir,
      env: { TERMINAL_MANAGER_VALUE: 'from-env' },
      cols: 120,
      rows: 40
    });
    command[2] = 'echo mutated';
    // @ts-expect-error exercises runtime immutability against stale callers.
    snapshot.command[2] = 'snapshot mutated';
    const current = await manager.get(snapshot.id);

    expect(snapshot.id).toBeString();
    expect(current?.command).toEqual(['/bin/sh', '-lc', 'sleep 1']);
    expect(current?.cwd).toBe(testDir);
    expect(current?.status).toBe('running');
    expect(manager.getTerminal(snapshot.id)?.id).toBe(snapshot.id);
  });

  it('gets, lists, reports active status, and records exit status', async () => {
    const manager = createManager();
    const snapshot = await manager.create({
      command: ['/bin/sh', '-lc', 'exit 7']
    });

    expect(await manager.get(snapshot.id)).toMatchObject({
      id: snapshot.id,
      status: 'running'
    });
    expect((await manager.list()).map((item) => item.id)).toContain(
      snapshot.id
    );
    expect(await manager.hasActive()).toBe(true);

    await Bun.sleep(200);

    expect(await manager.get(snapshot.id)).toMatchObject({
      id: snapshot.id,
      status: 'exited',
      exit: { code: 7, timedOut: false }
    });
    expect(await manager.hasActive()).toBe(false);
  });

  it('writes, resizes, interrupts, and terminates running terminals', async () => {
    const manager = createManager();
    const snapshot = await manager.create({
      command: ['/bin/sh'],
      cols: 80,
      rows: 24
    });

    await expect(manager.resize(snapshot.id, 100, 30)).resolves.toBeUndefined();
    await expect(
      manager.write(snapshot.id, new TextEncoder().encode('printf ok\\n\n'))
    ).resolves.toBeUndefined();
    expect(
      await nextData(
        await manager.output(snapshot.id, { replay: false, follow: true })
      )
    ).toContain('ok');
    await expect(manager.interrupt(snapshot.id)).resolves.toBeUndefined();
    await expect(manager.terminate(snapshot.id)).resolves.toBeUndefined();
  });

  it('retains only 25 exited terminals and never evicts active terminals', async () => {
    const manager = createManager();
    const active = await manager.create({
      command: ['/bin/sh', '-lc', 'sleep 5']
    });
    const exitedIds: string[] = [];

    for (let index = 0; index < MAX_RETAINED_TERMINALS + 1; index++) {
      const snapshot = await manager.create({
        command: ['/bin/sh', '-lc', `echo ${index}`]
      });
      exitedIds.push(snapshot.id);
    }

    await Bun.sleep(500);

    expect(await manager.get(active.id)).toMatchObject({
      id: active.id,
      status: 'running'
    });
    expect(await manager.get(exitedIds[0])).toBeNull();
    expect(await manager.get(exitedIds.at(-1) ?? '')).toMatchObject({
      status: 'exited'
    });
    expect(await manager.list()).toHaveLength(MAX_RETAINED_TERMINALS + 1);
  });

  it('validates not found, invalid command, and invalid cursor errors', async () => {
    const manager = createManager();

    await expect(
      manager.write('missing', new Uint8Array())
    ).rejects.toMatchObject({ code: ErrorCode.TERMINAL_NOT_FOUND });
    // @ts-expect-error exercises runtime validation at the RPC boundary.
    await expect(manager.create({ command: [] })).rejects.toMatchObject({
      code: ErrorCode.INVALID_COMMAND
    });

    await expect(manager.create({ command: [''] })).rejects.toMatchObject({
      code: ErrorCode.INVALID_COMMAND
    });
    // @ts-expect-error exercises runtime validation at the RPC boundary.
    await expect(manager.create({ command: [123] })).rejects.toMatchObject({
      code: ErrorCode.INVALID_COMMAND
    });

    const emptyArgument = await manager.create({ command: ['printf', ''] });
    await Bun.sleep(100);
    await expect(manager.get(emptyArgument.id)).resolves.toMatchObject({
      status: 'exited',
      exit: { code: 0, timedOut: false }
    });

    await expect(
      manager.create({ command: ['/bin/sh'], cwd: '/definitely/missing/cwd' })
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_TERMINAL_CWD,
      details: {
        cwd: '/definitely/missing/cwd',
        operation: 'create'
      }
    });

    const snapshot = await manager.create({
      command: ['/bin/sh', '-lc', 'sleep 1']
    });
    await expect(
      manager.output(snapshot.id, { since: '' })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_TERMINAL_CURSOR });
  });
});
