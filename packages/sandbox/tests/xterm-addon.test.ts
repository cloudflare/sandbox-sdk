import { describe, expect, it, vi } from 'vitest';
import { SandboxAddon } from '../src/xterm';

class MockSocket extends EventTarget {
  static instances: MockSocket[] = [];
  binaryType = '';
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
    MockSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  open() {
    this.dispatchEvent(new Event('open'));
  }

  closeFromServer() {
    this.dispatchEvent(new Event('close'));
  }
}

class MockTerminal {
  cols = 80;
  rows = 24;
  writes: Uint8Array[] = [];
  clear = vi.fn();
  focus = vi.fn();
  dataHandler: ((data: string) => void) | undefined;
  resizeHandler: ((size: { cols: number; rows: number }) => void) | undefined;

  write(data: Uint8Array) {
    this.writes.push(data);
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  }

  onResize(handler: (size: { cols: number; rows: number }) => void) {
    this.resizeHandler = handler;
    return { dispose: vi.fn() };
  }
}

function setup() {
  MockSocket.instances = [];
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.com' });
  vi.stubGlobal('WebSocket', MockSocket);
  const urls: string[] = [];
  const errors: string[] = [];
  const addon = new SandboxAddon({
    getWebSocketUrl: ({ origin, sandboxId, terminalId, cursor }) => {
      const url = `${origin}/ws/${sandboxId}/${terminalId}${cursor ? `?cursor=${cursor}` : ''}`;
      urls.push(url);
      return url;
    },
    onStateChange: (_state, error) => {
      if (error) errors.push(error.message);
    }
  });
  const terminal = new MockTerminal();
  // @ts-expect-error mock implements only the Terminal surface used by the addon.
  addon.activate(terminal);
  addon.connect({ sandboxId: 'sandbox-a', terminalId: 'terminal-a' });
  return { addon, terminal, urls, errors, socket: MockSocket.instances[0] };
}

describe('SandboxAddon terminal protocol', () => {
  it('advances reconnect cursor only after complete binary frame', () => {
    vi.useFakeTimers();
    const { terminal, urls, socket } = setup();

    socket.message(JSON.stringify({ type: 'ready' }));
    socket.message(
      JSON.stringify({ type: 'chunk', cursor: 'cursor-1', byteLength: 1 })
    );
    socket.closeFromServer();
    vi.runOnlyPendingTimers();

    expect(urls.at(-1)).toBe('wss://example.com/ws/sandbox-a/terminal-a');
    expect(terminal.writes).toHaveLength(0);

    MockSocket.instances
      .at(-1)
      ?.message(
        JSON.stringify({ type: 'chunk', cursor: 'cursor-2', byteLength: 1 })
      );
    MockSocket.instances.at(-1)?.message(new Uint8Array([65]).buffer);
    MockSocket.instances.at(-1)?.closeFromServer();
    vi.runOnlyPendingTimers();

    expect(urls.at(-1)).toContain('cursor=cursor-2');
    expect(terminal.writes).toEqual([new Uint8Array([65])]);
    vi.useRealTimers();
  });

  it('reports malformed and missing frame pairings', () => {
    const first = setup();
    first.socket.message(new Uint8Array([65]).buffer);
    expect(first.errors).toContain('Unexpected terminal data frame');
    expect(first.socket.closed).toBe(true);

    const second = setup();
    second.socket.message(
      JSON.stringify({ type: 'chunk', cursor: 'cursor-1', byteLength: 1 })
    );
    second.socket.message(
      JSON.stringify({ type: 'chunk', cursor: 'cursor-2', byteLength: 1 })
    );
    expect(second.errors).toContain('Terminal data frame missing');
    expect(second.socket.closed).toBe(true);
  });

  it('handles truncated ready and error control frames', () => {
    const { terminal, errors, socket } = setup();

    socket.message(JSON.stringify({ type: 'truncated', cursor: 'cursor-1' }));
    socket.message(JSON.stringify({ type: 'ready', cursor: 'cursor-1' }));
    socket.message(JSON.stringify({ type: 'error', message: 'boom' }));

    expect(terminal.clear).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();
    expect(errors).toContain('boom');
  });

  it('treats terminal exit as final and does not reconnect on server close', () => {
    vi.useFakeTimers();
    const { addon, errors, socket, urls } = setup();

    socket.message(JSON.stringify({ type: 'ready' }));
    socket.message(
      JSON.stringify({
        type: 'exit',
        cursor: 'cursor-2',
        exit: { code: 7, timedOut: false }
      })
    );
    socket.closeFromServer();
    vi.runOnlyPendingTimers();

    expect(addon.state).toBe('disconnected');
    expect(socket.closed).toBe(true);
    expect(urls).toHaveLength(1);
    expect(errors).toContain('Session exited with code 7');
    vi.useRealTimers();
  });

  it('preserves restored output when ready follows replayed data', () => {
    const { terminal, socket } = setup();

    socket.message(
      JSON.stringify({ type: 'chunk', cursor: 'cursor-1', byteLength: 1 })
    );
    socket.message(new Uint8Array([65]).buffer);
    socket.message(JSON.stringify({ type: 'ready', cursor: 'cursor-1' }));

    expect(terminal.writes).toEqual([new Uint8Array([65])]);
    expect(terminal.clear).not.toHaveBeenCalled();
  });
});
