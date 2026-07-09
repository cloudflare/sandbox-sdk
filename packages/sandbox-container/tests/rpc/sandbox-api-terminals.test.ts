import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  CreateTerminalOptions,
  SandboxTerminalsAPI,
  TerminalOutputEvent,
  TerminalSnapshot
} from '@repo/shared';
import {
  type SandboxAPIDeps,
  SandboxControlAPI
} from '@sandbox-container/control-plane';
import type { TerminalManager } from '@sandbox-container/services/terminal-manager';

function buildApi(terminalManager: TerminalManager): SandboxControlAPI {
  return new SandboxControlAPI({ terminalManager } as SandboxAPIDeps);
}

describe('SandboxControlAPI terminals', () => {
  let snapshot: TerminalSnapshot;
  let manager: TerminalManager;
  let terminals: SandboxTerminalsAPI;

  beforeEach(() => {
    snapshot = {
      id: 'generated-terminal-id',
      pid: 123,
      command: ['node', '-v'],
      cwd: '/workspace',
      status: 'running'
    };
    manager = {
      create: mock(async (_options: CreateTerminalOptions) => snapshot),
      get: mock(async (_id: string) => snapshot),
      list: mock(async () => [snapshot]),
      output: mock(async () => new ReadableStream()),
      write: mock(async () => undefined),
      resize: mock(async () => undefined),
      interrupt: mock(async () => undefined),
      terminate: mock(async () => undefined),
      hasActive: mock(async () => true)
    } as unknown as TerminalManager;
    terminals = buildApi(manager).terminals;
  });

  it('creates terminals through the focused terminals RPC API', async () => {
    const options: CreateTerminalOptions = {
      command: ['node', '-v'],
      cwd: '/workspace',
      env: { TEST: 'true' },
      cols: 120,
      rows: 40,
      bufferSize: 1024
    };

    await expect(terminals.create(options)).resolves.toEqual(snapshot);
    expect(manager.create).toHaveBeenCalledWith(options);
  });

  it('forwards status, output, and control operations without waiters', async () => {
    await expect(terminals.get('generated-terminal-id')).resolves.toEqual(
      snapshot
    );
    await expect(terminals.list()).resolves.toEqual([snapshot]);
    await expect(
      terminals.write('generated-terminal-id', new Uint8Array([65]))
    ).resolves.toBeUndefined();
    await expect(
      terminals.resize('generated-terminal-id', 100, 30)
    ).resolves.toBeUndefined();
    await expect(
      terminals.interrupt('generated-terminal-id')
    ).resolves.toBeUndefined();
    await expect(
      terminals.terminate('generated-terminal-id')
    ).resolves.toBeUndefined();
    await expect(terminals.hasActive()).resolves.toBe(true);

    expect('waitForExit' in terminals).toBe(false);
  });

  it('owns terminal output through a disposable subscription', async () => {
    const event: TerminalOutputEvent = {
      type: 'data',
      terminalId: 'generated-terminal-id',
      cursor: 'cursor-2',
      timestamp: new Date().toISOString(),
      data: new Uint8Array([65])
    };
    const sourceCancel = mock(() => undefined);
    manager.output = mock(
      async () =>
        new ReadableStream<TerminalOutputEvent>({
          start(controller) {
            controller.enqueue(event);
          },
          cancel: sourceCancel
        })
    );

    const subscription = await terminals.output('generated-terminal-id', {
      since: 'cursor-1',
      replay: true,
      follow: true
    });
    const reader = (await subscription.stream()).getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: event });
    await subscription.cancel();
    subscription[Symbol.dispose]();

    expect(sourceCancel).toHaveBeenCalledTimes(1);
    expect(manager.output).toHaveBeenCalledWith('generated-terminal-id', {
      since: 'cursor-1',
      replay: true,
      follow: true
    });
  });
});
