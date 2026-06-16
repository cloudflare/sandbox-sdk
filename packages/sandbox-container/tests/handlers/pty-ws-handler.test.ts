import { describe, expect, it, mock } from 'bun:test';
import type { Disposable } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import {
  PtyWebSocketHandler,
  type PtyWSData
} from '../../src/handlers/pty-ws-handler';
import type { Pty } from '../../src/pty';
import type { TerminalHandle } from '../../src/services/terminal-manager';

type MockWebSocket = Pick<
  ServerWebSocket<PtyWSData>,
  'data' | 'send' | 'sendBinary' | 'close'
>;

type MockPty = Pick<
  Pty,
  'getBufferedOutput' | 'onData' | 'write' | 'resize'
> & {
  closed: boolean;
};

const createMockWS = (data: PtyWSData): MockWebSocket => ({
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
    getOrCreateTerminal: mock(() => Promise.resolve(handle))
  };
}

describe('PtyWebSocketHandler', () => {
  const logger = createNoOpLogger();

  it('creates terminals through TerminalManager on connection', async () => {
    const mockPty = createMockPty();
    const terminalManager = createTerminalManager(mockPty);
    const handler = new PtyWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'pty',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<PtyWSData>);

    expect(terminalManager.getOrCreateTerminal).toHaveBeenCalledWith({
      id: 'test-terminal',
      pty: {
        cols: undefined,
        rows: undefined,
        shell: undefined
      }
    });
    expect(ws.sendBinary).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalled();
  });

  it('closes connection with error when terminal creation fails', async () => {
    const terminalManager = {
      getOrCreateTerminal: mock(() => Promise.reject(new Error('Spawn failed')))
    };
    const handler = new PtyWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'pty',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<PtyWSData>);

    expect(ws.close).toHaveBeenCalledWith(1011, 'Spawn failed');
  });

  it('forwards binary messages to PTY as input', async () => {
    const mockPty = createMockPty();
    const terminalManager = createTerminalManager(mockPty);
    const handler = new PtyWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'pty',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<PtyWSData>);
    handler.onMessage(
      ws as ServerWebSocket<PtyWSData>,
      new Uint8Array([104, 101, 108, 108, 111]).buffer
    );

    expect(mockPty.write).toHaveBeenCalled();
  });

  it('handles resize control messages', async () => {
    const mockPty = createMockPty();
    const terminalManager = createTerminalManager(mockPty);
    const handler = new PtyWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'pty',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<PtyWSData>);
    handler.onMessage(
      ws as ServerWebSocket<PtyWSData>,
      JSON.stringify({ type: 'resize', cols: 120, rows: 40 })
    );

    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('cleans up subscription on close without destroying the terminal', async () => {
    const mockDispose = mock(() => {});
    const mockPty = createMockPty({
      onData: mock(() => ({ dispose: mockDispose }))
    });
    const terminalManager = {
      ...createTerminalManager(mockPty),
      destroyTerminal: mock(() => Promise.resolve())
    };
    const handler = new PtyWebSocketHandler(terminalManager, logger);
    const ws = createMockWS({
      type: 'pty',
      terminalId: 'test-terminal',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as ServerWebSocket<PtyWSData>);
    handler.onClose(ws as ServerWebSocket<PtyWSData>, 1000, 'Normal closure');

    expect(mockDispose).toHaveBeenCalled();
    expect(terminalManager.destroyTerminal).not.toHaveBeenCalled();
  });
});
