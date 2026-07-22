import { describe, expect, it, mock } from 'bun:test';
import type {
  RuntimeTerminalOutputEvent,
  RuntimeTerminalProcess
} from '@repo/sandbox-execution';
import { createNoOpLogger } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import {
  TerminalWebSocketHandler,
  type TerminalWSData
} from '../../src/handlers/terminal-ws-handler';
import type { TerminalHandle } from '../../src/services/terminal-manager';

type MockWebSocket = Pick<
  ServerWebSocket<TerminalWSData>,
  'data' | 'send' | 'sendBinary' | 'close'
>;

type MockPty = RuntimeTerminalProcess;

const createMockWS = (
  data: Omit<TerminalWSData, 'runtimeIncarnationID'> &
    Partial<Pick<TerminalWSData, 'runtimeIncarnationID'>>
): MockWebSocket => ({
  data: { runtimeIncarnationID: 'runtime-incarnation-test', ...data },
  send: mock(() => 1),
  sendBinary: mock(() => 1),
  close: mock(() => {})
});

const createOutputStream = (
  events: RuntimeTerminalOutputEvent[] = [
    {
      type: 'data',
      cursor: 'cursor-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: new Uint8Array([1, 2, 3])
    }
  ]
): ReadableStream<RuntimeTerminalOutputEvent> =>
  new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    }
  });

const createMockPty = (overrides: Partial<MockPty> = {}): MockPty => ({
  snapshot: mock(() => ({ pid: 1, state: 'running' as const })),
  output: mock(() => createOutputStream()),
  write: mock(async () => {}),
  resize: mock(() => {}),
  waitForExit: mock(async () => ({
    state: 'exited' as const,
    exit: { code: 0, timedOut: false }
  })),
  interrupt: mock(async () => {}),
  terminate: mock(async () => {}),
  close: mock(async () => {}),
  ...overrides
});

function createTerminalManager(mockPty = createMockPty()) {
  const handle: TerminalHandle = {
    id: 'test-terminal',
    pty: mockPty
  };

  return {
    getTerminal: mock(() => handle)
  };
}

describe('TerminalWebSocketHandler', () => {
  const logger = createNoOpLogger();

  it('attaches to existing terminals on connection', async () => {
    const mockPty = createMockPty();
    const terminalManager = createTerminalManager(mockPty);
    const handler = new TerminalWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1',
      cols: 120,
      rows: 40
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    await Bun.sleep(0);

    expect(terminalManager.getTerminal).toHaveBeenCalledWith('test-terminal');
    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    expect(ws.sendBinary).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalled();
  });

  it('closes connection with error when terminal does not exist', async () => {
    const terminalManager = {
      getTerminal: mock(() => undefined)
    };
    const handler = new TerminalWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'missing-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Terminal not found');
  });

  it('forwards binary messages to terminal as input', async () => {
    const mockPty = createMockPty();
    const terminalManager = createTerminalManager(mockPty);
    const handler = new TerminalWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    handler.onMessage(
      ws as ServerWebSocket<TerminalWSData>,
      new Uint8Array([104, 101, 108, 108, 111]).buffer
    );
    await Bun.sleep(0);

    expect(mockPty.write).toHaveBeenCalled();
  });

  it('handles resize control messages', async () => {
    const mockPty = createMockPty();
    const terminalManager = createTerminalManager(mockPty);
    const handler = new TerminalWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    handler.onMessage(
      ws as ServerWebSocket<TerminalWSData>,
      JSON.stringify({ type: 'resize', cols: 120, rows: 40 })
    );

    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('forwards terminal exit status and closes intentionally', async () => {
    const mockPty = createMockPty({
      output: mock(() =>
        createOutputStream([
          {
            type: 'data',
            cursor: 'cursor-1',
            timestamp: '2026-01-01T00:00:00.000Z',
            data: new Uint8Array([65])
          },
          {
            type: 'terminal',
            cursor: 'cursor-2',
            timestamp: '2026-01-01T00:00:00.001Z',
            state: 'exited',
            exit: { code: 143, signal: 15, timedOut: false }
          }
        ])
      )
    });
    const terminalManager = createTerminalManager(mockPty);
    const handler = new TerminalWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    for (let attempt = 0; attempt < 10; attempt++) await Bun.sleep(0);
    expect(ws.sendBinary).toHaveBeenCalledWith(new Uint8Array([65]));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'chunk',
        cursor: 'cursor-1',
        byteLength: 1
      })
    );
    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'exit',
        cursor: 'cursor-2',
        exit: { code: 143, signal: 15, timedOut: false }
      })
    );
    expect(ws.close).toHaveBeenCalledWith(1000, 'Terminal exited');
  });

  it('forwards structured terminal failures without fabricating an exit', async () => {
    const mockPty = createMockPty({
      output: mock(() =>
        createOutputStream([
          {
            type: 'terminal',
            cursor: 'cursor-error',
            timestamp: '2026-01-01T00:00:00.001Z',
            state: 'error',
            error: { code: 'DRAIN_FAILED', message: 'stdout failed' }
          }
        ])
      )
    });
    const handler = new TerminalWebSocketHandler(
      createTerminalManager(mockPty),
      logger
    );
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    for (let attempt = 0; attempt < 10; attempt++) await Bun.sleep(0);

    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'error',
        cursor: 'cursor-error',
        code: 'DRAIN_FAILED',
        message: 'stdout failed'
      })
    );
    expect(ws.send).not.toHaveBeenCalledWith(
      expect.stringContaining('"type":"exit"')
    );
    expect(ws.close).toHaveBeenCalledWith(1011, 'Terminal error');
  });

  it('closes followed output streams that complete without an event', async () => {
    const mockPty = createMockPty({
      output: mock(() => createOutputStream([]))
    });
    const handler = new TerminalWebSocketHandler(
      createTerminalManager(mockPty),
      logger
    );
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1',
      cursor: 'terminal-cursor'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    for (let attempt = 0; attempt < 10; attempt++) await Bun.sleep(0);

    expect(mockPty.output).toHaveBeenCalledWith({
      after: 'terminal-cursor',
      replay: true,
      follow: true
    });
    expect(ws.close).toHaveBeenCalledWith(1000, 'Terminal output complete');
  });

  it('closes and cancels when JSON chunk send fails', async () => {
    let cancelled = false;
    const mockPty = createMockPty({
      output: mock(
        () =>
          new ReadableStream<RuntimeTerminalOutputEvent>({
            start(controller) {
              controller.enqueue({
                type: 'data',
                cursor: 'cursor-1',
                timestamp: '2026-01-01T00:00:00.000Z',
                data: new Uint8Array([65])
              });
            },
            cancel() {
              cancelled = true;
            }
          })
      )
    });
    const handler = new TerminalWebSocketHandler(
      createTerminalManager(mockPty),
      logger
    );
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });
    let sendCount = 0;
    ws.send = mock(() => (sendCount++ === 0 ? 1 : 0));

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    for (let attempt = 0; attempt < 10; attempt++) await Bun.sleep(0);

    expect(ws.close).toHaveBeenCalledWith(1011, 'Terminal send failed');
    expect(cancelled).toBe(true);
  });

  it('closes and cancels when truncated control send throws', async () => {
    let cancelled = false;
    const mockPty = createMockPty({
      output: mock(
        () =>
          new ReadableStream<RuntimeTerminalOutputEvent>({
            start(controller) {
              controller.enqueue({
                type: 'truncated',
                cursor: 'cursor-1',
                timestamp: '2026-01-01T00:00:00.000Z'
              });
            },
            cancel() {
              cancelled = true;
            }
          })
      )
    });
    const handler = new TerminalWebSocketHandler(
      createTerminalManager(mockPty),
      logger
    );
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });
    let sendCount = 0;
    ws.send = mock(() => {
      if (sendCount++ > 0) throw new Error('send failed');
      return 1;
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    for (let attempt = 0; attempt < 10; attempt++) await Bun.sleep(0);

    expect(ws.close).toHaveBeenCalledWith(1011, 'Terminal send failed');
    expect(cancelled).toBe(true);
  });

  it.each([0, -1])(
    'closes and cancels when invalid control error returns %p',
    async (sendResult) => {
      let cancelled = false;
      const mockPty = createMockPty({
        output: mock(
          () =>
            new ReadableStream<RuntimeTerminalOutputEvent>({
              cancel() {
                cancelled = true;
              }
            })
        )
      });
      const handler = new TerminalWebSocketHandler(
        createTerminalManager(mockPty),
        logger
      );
      const ws = createMockWS({
        type: 'terminal',
        terminalId: 'test-terminal',
        connectionId: 'conn-1'
      });
      let sendCount = 0;
      ws.send = mock(() => (sendCount++ === 0 ? 1 : sendResult));

      await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
      handler.onMessage(
        ws as ServerWebSocket<TerminalWSData>,
        '{"type":"bogus"}'
      );
      await Bun.sleep(0);

      expect(ws.close).toHaveBeenCalledWith(1011, 'Terminal send failed');
      expect(cancelled).toBe(true);
    }
  );

  it('closes and cancels when invalid control error send throws', async () => {
    let cancelled = false;
    const mockPty = createMockPty({
      output: mock(
        () =>
          new ReadableStream<RuntimeTerminalOutputEvent>({
            cancel() {
              cancelled = true;
            }
          })
      )
    });
    const handler = new TerminalWebSocketHandler(
      createTerminalManager(mockPty),
      logger
    );
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });
    let sendCount = 0;
    ws.send = mock(() => {
      if (sendCount++ > 0) throw new Error('send failed');
      return 1;
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    handler.onMessage(ws as ServerWebSocket<TerminalWSData>, 'not json');
    await Bun.sleep(0);

    expect(ws.close).toHaveBeenCalledWith(1011, 'Terminal send failed');
    expect(cancelled).toBe(true);
  });

  it('cancels output on close without destroying terminals', async () => {
    let cancelled = false;
    const mockPty = createMockPty({
      output: mock(
        () =>
          new ReadableStream<RuntimeTerminalOutputEvent>({
            cancel() {
              cancelled = true;
            }
          })
      )
    });
    const terminalManager = createTerminalManager(mockPty);
    const handler = new TerminalWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'terminal',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<TerminalWSData>);
    handler.onClose(
      ws as ServerWebSocket<TerminalWSData>,
      1000,
      'Normal closure'
    );
    await Bun.sleep(0);

    expect(cancelled).toBe(true);
  });
});
