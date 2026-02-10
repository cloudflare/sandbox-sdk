import { describe, expect, it, mock } from 'bun:test';
import type { Disposable, PtyOptions } from '@repo/shared';
import { createNoOpLogger } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import type { ServiceResult } from '../../src/core/types';
import {
  PtyWebSocketHandler,
  type PtyWSData
} from '../../src/handlers/pty-ws-handler';
import type { Pty } from '../../src/pty';

type MockWebSocket = Pick<
  ServerWebSocket<PtyWSData>,
  'data' | 'send' | 'sendBinary' | 'close'
>;

interface MockSessionManager {
  getPty: (
    sessionId: string,
    options?: PtyOptions
  ) => Promise<ServiceResult<Pty>>;
}

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

describe('PtyWebSocketHandler', () => {
  const logger = createNoOpLogger();

  it('should send buffered output and ready message on connection', async () => {
    const mockPty = createMockPty();
    const sessionManager = {
      getPty: mock(() => Promise.resolve({ success: true, data: mockPty }))
    };
    const handler = new PtyWebSocketHandler(sessionManager as any, logger);
    const ws = createMockWS({
      type: 'pty',
      sessionId: 'test-session',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as any);

    expect(sessionManager.getPty).toHaveBeenCalledWith('test-session', {
      cols: undefined,
      rows: undefined
    });
    expect(ws.sendBinary).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalled();
  });

  it('should close connection with error when PTY creation fails', async () => {
    const sessionManager = {
      getPty: mock(() =>
        Promise.resolve({ success: false, error: { message: 'Spawn failed' } })
      )
    };
    const handler = new PtyWebSocketHandler(sessionManager as any, logger);
    const ws = createMockWS({
      type: 'pty',
      sessionId: 'test-session',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as any);

    expect(ws.close).toHaveBeenCalledWith(1011, expect.any(String));
  });

  it('should forward binary messages to PTY as input', async () => {
    const mockPty = createMockPty();
    const sessionManager = {
      getPty: mock(() => Promise.resolve({ success: true, data: mockPty }))
    };
    const handler = new PtyWebSocketHandler(sessionManager as any, logger);
    const ws = createMockWS({
      type: 'pty',
      sessionId: 'test-session',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as any);
    handler.onMessage(
      ws as any,
      new Uint8Array([104, 101, 108, 108, 111]).buffer
    );

    expect(mockPty.write).toHaveBeenCalled();
  });

  it('should handle resize control messages', async () => {
    const mockPty = createMockPty();
    const sessionManager = {
      getPty: mock(() => Promise.resolve({ success: true, data: mockPty }))
    };
    const handler = new PtyWebSocketHandler(sessionManager as any, logger);
    const ws = createMockWS({
      type: 'pty',
      sessionId: 'test-session',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as any);
    handler.onMessage(
      ws as any,
      JSON.stringify({ type: 'resize', cols: 120, rows: 40 })
    );

    expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('should cleanup subscription on close', async () => {
    const mockDispose = mock(() => {});
    const mockPty = createMockPty({
      onData: mock(() => ({ dispose: mockDispose }))
    });
    const sessionManager = {
      getPty: mock(() => Promise.resolve({ success: true, data: mockPty }))
    };
    const handler = new PtyWebSocketHandler(sessionManager as any, logger);
    const ws = createMockWS({
      type: 'pty',
      sessionId: 'test-session',
      connectionId: 'conn-1'
    });

    await handler.onOpen(ws as any);
    handler.onClose(ws as any, 1000, 'Normal closure');

    expect(mockDispose).toHaveBeenCalled();
  });
});
