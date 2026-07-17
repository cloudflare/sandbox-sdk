import type { PtyServerControlMessage } from '@repo/shared';
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import type {
  ConnectionState,
  ConnectionTarget,
  SandboxAddonOptions
} from './types';

const DEFAULT_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_EXPONENT = 5;
const JITTER_FACTOR = 0.1;

export class SandboxAddon implements ITerminalAddon {
  private terminal: Terminal | null = null;
  private socket: WebSocket | null = null;
  private disposables: IDisposable[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restoredOutput = false;
  private intentionalDisconnect = false;
  private textEncoder = new TextEncoder();
  private pendingChunk: { cursor: string; byteLength: number } | null = null;
  private cursor: string | undefined;

  private _state: ConnectionState = 'disconnected';
  private _sandboxId: string | undefined;
  private _terminalId: string | undefined;

  get state(): ConnectionState {
    return this._state;
  }
  get sandboxId(): string | undefined {
    return this._sandboxId;
  }
  get terminalId(): string | undefined {
    return this._terminalId;
  }

  constructor(private options: SandboxAddonOptions) {}

  activate(terminal: Terminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    this.closeSocket();
    this.terminal = null;
  }

  connect(target: ConnectionTarget): void {
    if (!this.terminal) return;

    const isSameTarget =
      target.sandboxId === this._sandboxId &&
      target.terminalId === this._terminalId;

    if (isSameTarget && this._state !== 'disconnected') {
      return;
    }

    this._sandboxId = target.sandboxId;
    this._terminalId = target.terminalId;

    this.cancelReconnect();
    this.closeSocket();
    this.reconnectAttempts = 0;
    this.cursor = undefined;
    this.restoredOutput = false;
    this.pendingChunk = null;
    this.intentionalDisconnect = false;

    if (this._state !== 'disconnected') {
      this.terminal.clear();
    }

    this.doConnect();
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    this.closeSocket();
    this.setState('disconnected');
  }

  private setState(state: ConnectionState, error?: Error): void {
    if (this._state === state && !error) return;
    this._state = state;
    this.options.onStateChange?.(state, error);
  }

  private doConnect(): void {
    if (!this.terminal || !this._sandboxId) return;

    this.setState('connecting');

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const origin = `${wsProtocol}//${location.host}`;

    const url = this.options.getWebSocketUrl({
      sandboxId: this._sandboxId,
      terminalId: this._terminalId,
      cursor: this.cursor,
      origin
    });

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    this.registerSocketListener(socket, 'open', this.onSocketOpen.bind(this));
    this.registerSocketListener(socket, 'message', (e) =>
      this.onSocketMessage(e)
    );
    this.registerSocketListener(socket, 'close', this.onSocketClose.bind(this));
    this.registerSocketListener(socket, 'error', this.onSocketError.bind(this));
  }

  private registerSocketListener(
    socket: WebSocket,
    type: string,
    listener: (ev: Event) => void
  ): void {
    socket.addEventListener(type, listener);
    this.disposables.push({
      dispose: () => socket.removeEventListener(type, listener)
    });
  }

  private onSocketOpen(): void {
    if (!this.terminal) return;
    this.disposables.push(this.terminal.onData((data) => this.sendData(data)));
    this.disposables.push(
      this.terminal.onResize(({ cols, rows }) => this.sendResize(cols, rows))
    );
  }

  private onSocketMessage(event: Event): void {
    if (!this.terminal) return;
    const { data } = event as MessageEvent;

    if (data instanceof ArrayBuffer) {
      this.consumeBinary(new Uint8Array(data));
      return;
    }

    if (typeof data === 'string') {
      try {
        this.handleControlMessage(JSON.parse(data) as PtyServerControlMessage);
      } catch {
        this.setState(this._state, new Error('Invalid terminal control frame'));
        this.closeSocket();
      }
    }
  }

  private consumeBinary(data: Uint8Array): void {
    if (!this.pendingChunk) {
      this.setState(this._state, new Error('Unexpected terminal data frame'));
      this.closeSocket();
      return;
    }
    if (data.byteLength !== this.pendingChunk.byteLength) {
      this.setState(
        this._state,
        new Error('Terminal data frame length mismatch')
      );
      this.closeSocket();
      return;
    }
    this.restoredOutput = true;
    this.terminal?.write(data);
    this.cursor = this.pendingChunk.cursor;
    this.pendingChunk = null;
  }

  private handleControlMessage(msg: PtyServerControlMessage): void {
    switch (msg.type) {
      case 'ready':
        if (msg.cursor) this.cursor = msg.cursor;
        if (!this.restoredOutput) {
          this.terminal?.clear();
        }
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.terminal?.focus();
        if (this.terminal) {
          this.sendResize(this.terminal.cols, this.terminal.rows);
        }
        break;

      case 'chunk':
        if (this.pendingChunk) {
          this.setState(this._state, new Error('Terminal data frame missing'));
          this.closeSocket();
          return;
        }
        this.pendingChunk = { cursor: msg.cursor, byteLength: msg.byteLength };
        break;

      case 'truncated':
        this.cursor = msg.cursor;
        this.terminal?.clear();
        this.restoredOutput = false;
        break;

      case 'error':
        this.options.onStateChange?.(this._state, new Error(msg.message));
        break;

      case 'exit':
        this.cursor = msg.cursor;
        this.intentionalDisconnect = true;
        this.options.onStateChange?.(
          this._state,
          new Error(
            `Session exited with code ${msg.exit.code}${msg.exit.signal ? ` (${msg.exit.signal})` : ''}`
          )
        );
        this.closeSocket();
        this.setState('disconnected');
        break;
    }
  }

  private onSocketClose(): void {
    this.closeSocket();

    if (this.intentionalDisconnect) {
      this.setState('disconnected');
      return;
    }

    const shouldReconnect = this.options.reconnect !== false;

    if (!shouldReconnect) {
      this.setState('disconnected');
      return;
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState(
        'disconnected',
        new Error('Max reconnection attempts exceeded')
      );
      return;
    }

    this.scheduleReconnect();
  }

  private onSocketError(): void {
    this.options.onStateChange?.(this._state, new Error('WebSocket error'));
  }

  private scheduleReconnect(): void {
    const exponent = Math.min(this.reconnectAttempts, MAX_BACKOFF_EXPONENT);
    const delay = DEFAULT_RECONNECT_DELAY * 2 ** exponent;
    const jitter = delay * JITTER_FACTOR * Math.random();

    this.setState('disconnected');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.doConnect();
    }, delay + jitter);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.pendingChunk = null;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private sendData(data: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(this.textEncoder.encode(data));
    }
  }

  private sendResize(cols: number, rows: number): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }
}
