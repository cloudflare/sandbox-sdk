import { describe, expect, it, mock } from 'bun:test';
import type { Disposable } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import {
  TerminalWebSocketHandler,
  type TerminalWSData
} from '../../src/handlers/terminal-ws-handler';
import type { Pty } from '../../src/pty';
import type { TerminalHandle } from '../../src/services/terminal-manager';

type MockWebSocket = Pick<
  ServerWebSocket<TerminalWSData>,
  'data' | 'send' | 'sendBinary' | 'close'
>;

type MockPty = Pick<
  Pty,
  'getBufferedOutput' | 'onData' | 'write' | 'resize'
> & {
  closed: boolean;
};

const createMockWS = (data: TerminalWSData): MockWebSocket => ({
  data,
  send: mock(() => 0),
  sendBinary: mock(() => 1),
  close: mock(() => {})
});

const createMockPty = (overrides: Partial<MockPty> = {}): MockPty => ({
  getBufferedOutput: () => new Uint8Array([1, 2, 3]),
  onData: mock((): Disposable => ({ dispose: () => {} })),
  write: mock(() => {}),
  resize: mock(() => {}),
  closed: false,
  ...overrides
});

function createTerminalManager(mockPty = createMockPty()) {
  const handle: TerminalHandle = {
    id: 'test-terminal',
    pty: mockPty as Pty
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

  it('cleans up subscription on close without destroying terminals', async () => {
    const mockDispose = mock(() => {});
    const mockPty = createMockPty({
      onData: mock(() => ({ dispose: mockDispose }))
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

    expect(mockDispose).toHaveBeenCalled();
  });
});
