import type {
  CreateTerminalOptions,
  TerminalOutputEvent,
  TerminalOutputSubscriptionAPI,
  TerminalSnapshot
} from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  InvalidTerminalCursorError,
  TerminalControlError,
  TerminalNotFoundError
} from '../src';
import { ErrorCode } from '../src/errors';
import {
  createTerminalHandle,
  getTerminalHandle,
  listTerminalHandles,
  terminalHandle
} from '../src/pty';

function snapshot(id: string): TerminalSnapshot {
  return {
    id,
    command: ['bash'],
    status: 'running'
  };
}

function outputSubscription(stream: ReadableStream<TerminalOutputEvent>) {
  return {
    stream: vi.fn(async () => stream),
    cancel: vi.fn(async () => undefined),
    [Symbol.dispose]: vi.fn()
  } satisfies TerminalOutputSubscriptionAPI;
}

function createStub(onFetch?: (request: Request) => void | Promise<void>) {
  const snapshots = new Map<string, TerminalSnapshot>([
    ['terminal-123', snapshot('terminal-123')],
    ['terminal-456', snapshot('terminal-456')]
  ]);
  return {
    fetch: vi.fn(async (request: Request) => {
      await onFetch?.(request);
      return new Response(null, { status: 200 });
    }),
    create: vi.fn(async (options: CreateTerminalOptions) => {
      const created: TerminalSnapshot = {
        id: 'generated-terminal',
        command: options.command,
        cwd: options.cwd,
        status: 'running'
      };
      snapshots.set(created.id, created);
      return created;
    }),
    get: vi.fn(async (id: string) => snapshots.get(id) ?? null),
    list: vi.fn(async () => [...snapshots.values()]),
    output: vi.fn(
      async (_id: string, _options?: { replay?: boolean; follow?: boolean }) =>
        outputSubscription(
          new ReadableStream<TerminalOutputEvent>({
            start(controller) {
              controller.enqueue({
                type: 'terminal',
                terminalId: 'terminal-123',
                cursor: '1',
                timestamp: new Date().toISOString(),
                state: 'exited',
                exit: { code: 0, timedOut: false }
              });
              controller.close();
            }
          })
        )
    ),
    write: vi.fn(async (_id: string, _data: Uint8Array) => {}),
    resize: vi.fn(async (_id: string, _cols: number, _rows: number) => {}),
    interrupt: vi.fn(async (_id: string) => {}),
    terminate: vi.fn(async (_id: string) => {}),
    hasActive: vi.fn(async () => true)
  };
}

describe('terminal proxy', () => {
  it('exports terminal error classes from the package root', () => {
    expect(TerminalNotFoundError).toBeTypeOf('function');
    expect(InvalidTerminalCursorError).toBeTypeOf('function');
    expect(TerminalControlError).toBeTypeOf('function');
  });

  it('returns the same handle contract from create, get, and list', async () => {
    const stub = createStub();

    const created = await createTerminalHandle(stub, {
      command: ['bash'],
      cwd: '/workspace'
    });
    const fetched = await getTerminalHandle(stub, created.id);
    const listed = await listTerminalHandles(stub);

    expect(created.id).toBe('generated-terminal');
    expect(fetched?.id).toBe(created.id);
    expect(listed.map((terminal) => terminal.id)).toContain(created.id);
    expect(stub.create).toHaveBeenCalledWith({
      command: ['bash'],
      cwd: '/workspace'
    });
  });

  it('proxies WebSocket connects with terminal cursor options only', async () => {
    let proxiedRequest: Request | undefined;
    const stub = createStub((request) => {
      proxiedRequest = request;
    });
    const request = new Request('https://example.com/terminal', {
      headers: { Upgrade: 'websocket' }
    });

    const terminal = terminalHandle(
      stub,
      snapshot('terminal-123'),
      'runtime-incarnation-1'
    );
    await terminal.connect(request, {
      cursor: 'cursor-1',
      cols: 120,
      rows: 40
    });

    expect(stub.fetch).toHaveBeenCalledOnce();
    const url = new URL(proxiedRequest?.url ?? 'http://missing');
    expect(url.pathname).toBe('/ws/terminal');
    expect(url.searchParams.get('terminalId')).toBe('terminal-123');
    expect(url.searchParams.get('cursor')).toBe('cursor-1');
    expect(url.searchParams.get('cols')).toBe('120');
    expect(url.searchParams.get('rows')).toBe('40');
    expect(url.searchParams.get('runtimeIncarnationID')).toBe(
      'runtime-incarnation-1'
    );
    expect(url.searchParams.get('shell')).toBeNull();
    expect(url.searchParams.get('id')).toBeNull();
  });

  it('cancels and disposes followed output after receiving data', async () => {
    const stub = createStub();
    const terminal = terminalHandle(stub, snapshot('terminal-123'));
    const abortController = new AbortController();
    const event: TerminalOutputEvent = {
      type: 'data',
      terminalId: 'terminal-123',
      cursor: '1',
      timestamp: new Date().toISOString(),
      data: new Uint8Array([65])
    };
    const sourceCancel = vi.fn();
    const subscription = outputSubscription(
      new ReadableStream<TerminalOutputEvent>({
        start(controller) {
          controller.enqueue(event);
        },
        cancel: sourceCancel
      })
    );
    stub.output.mockResolvedValueOnce(subscription);

    const stream = await terminal.output({
      replay: true,
      follow: true,
      signal: abortController.signal
    });
    const reader = stream.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: event });
    abortController.abort();

    await expect(reader.read()).resolves.toEqual({ done: true });
    expect(stub.output).toHaveBeenCalledWith('terminal-123', {
      replay: true,
      follow: true
    });
    expect(sourceCancel).toHaveBeenCalledTimes(1);
    expect(subscription.cancel).toHaveBeenCalledTimes(1);
    expect(subscription[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('reports AbortSignal reason instead of timeout when signal wins', async () => {
    const stub = createStub();
    const terminal = terminalHandle(stub, snapshot('terminal-123'));
    const subscription = outputSubscription(
      new ReadableStream<TerminalOutputEvent>()
    );
    stub.output.mockResolvedValueOnce(subscription);
    const abortController = new AbortController();
    const wait = terminal.waitForExit({
      timeout: 1000,
      signal: abortController.signal
    });

    abortController.abort(new Error('caller aborted'));

    await expect(wait).rejects.toThrow('caller aborted');
    expect(subscription.cancel).toHaveBeenCalledTimes(1);
    expect(subscription[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it('reports timeout when timeout wins abort race', async () => {
    vi.useFakeTimers();
    const stub = createStub();
    const terminal = terminalHandle(stub, snapshot('terminal-123'));
    const subscription = outputSubscription(
      new ReadableStream<TerminalOutputEvent>()
    );
    stub.output.mockResolvedValueOnce(subscription);
    const abortController = new AbortController();
    const wait = expect(
      terminal.waitForExit({
        timeout: 10,
        signal: abortController.signal
      })
    ).rejects.toThrow('Terminal wait timed out');

    await vi.advanceTimersByTimeAsync(10);
    abortController.abort(new Error('late abort'));

    await wait;
    expect(subscription.cancel).toHaveBeenCalledTimes(1);
    expect(subscription[Symbol.dispose]).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('rejects waitForExit with structured terminal runtime errors', async () => {
    const stub = createStub();
    stub.output.mockResolvedValueOnce(
      outputSubscription(
        new ReadableStream<TerminalOutputEvent>({
          start(controller) {
            controller.enqueue({
              type: 'terminal',
              terminalId: 'terminal-123',
              cursor: '1',
              timestamp: new Date().toISOString(),
              state: 'error',
              error: {
                code: 'PROCESS_SPAWN_FAILED',
                message: 'spawn failed: permission denied'
              }
            });
            controller.close();
          }
        })
      )
    );
    const terminal = terminalHandle(stub, snapshot('terminal-123'));

    await expect(terminal.waitForExit()).rejects.toMatchObject({
      name: 'TerminalControlError',
      code: ErrorCode.TERMINAL_CONTROL_ERROR,
      message: 'spawn failed: permission denied',
      context: {
        terminalId: 'terminal-123',
        operation: 'waitForExit',
        reason: 'spawn failed: permission denied',
        failure: {
          code: 'PROCESS_SPAWN_FAILED',
          message: 'spawn failed: permission denied'
        }
      }
    });
  });

  it('forwards process control methods and waits through output', async () => {
    const stub = createStub();
    const terminal = terminalHandle(stub, snapshot('terminal-123'));

    await terminal.write(new Uint8Array([1, 2, 3]));
    await terminal.resize(100, 30);
    await terminal.interrupt();
    await terminal.terminate();
    await expect(terminal.waitForExit()).resolves.toEqual({
      code: 0,
      timedOut: false
    });

    expect(stub.write).toHaveBeenCalledWith(
      'terminal-123',
      new Uint8Array([1, 2, 3])
    );
    expect(stub.resize).toHaveBeenCalledWith('terminal-123', 100, 30);
    expect(stub.interrupt).toHaveBeenCalledWith('terminal-123');
    expect(stub.terminate).toHaveBeenCalledWith('terminal-123');
    expect(stub.output).toHaveBeenCalledWith('terminal-123', {
      replay: true,
      follow: true
    });
  });
});
