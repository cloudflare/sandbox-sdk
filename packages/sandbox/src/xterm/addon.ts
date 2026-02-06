import type { PtyStatusMessage } from '@repo/shared';
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import type { ConnectionState, SandboxAddonOptions } from './types';

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
  private hasReceivedBuffer = false;
  private intentionalDisconnect = false;
  private textEncoder = new TextEncoder();

  private _state: ConnectionState = 'disconnected';
  private _sandboxId: string;
  private _sessionId: string | undefined;

  get state(): ConnectionState {
    return this._state;
  }
  get sandboxId(): string {
    return this._sandboxId;
  }
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  constructor(private options: SandboxAddonOptions) {
    this._sandboxId = options.sandboxId;
    this._sessionId = options.sessionId;
  }

  activate(terminal: Terminal): void {
    this.terminal = terminal;
  }

  dispose(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    this.closeSocket();
    this.terminal = null;
  }

  connect(): void {
    if (this._state !== 'disconnected' || !this.terminal) return;
    this.intentionalDisconnect = false;
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    this.closeSocket();
    this.setState('disconnected');
  }

  setSandbox(sandboxId: string): void {
    if (sandboxId === this._sandboxId) return;
    this._sandboxId = sandboxId;
    this.reconnectToNew();
  }

  setSession(sessionId: string | undefined): void {
    if (sessionId === this._sessionId) return;
    this._sessionId = sessionId;
    this.reconnectToNew();
  }

  private setState(state: ConnectionState, error?: Error): void {
    if (this._state === state) return;
    this._state = state;
    this.options.onStateChange?.(state, error);
  }

  private doConnect(): void {
    if (!this.terminal) return;

    this.setState('connecting');
    this.hasReceivedBuffer = false;

    const url = this.options.getWebSocketUrl({
      sandboxId: this._sandboxId,
      sessionId: this._sessionId
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
      this.hasReceivedBuffer = true;
      this.terminal.write(new Uint8Array(data));
      return;
    }

    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as PtyStatusMessage;
        this.handleControlMessage(msg);
      } catch {
        // Non-JSON string messages are silently ignored - protocol expects
        // binary for terminal data and JSON for control messages only
      }
    }
  }

  private handleControlMessage(msg: PtyStatusMessage): void {
    switch (msg.type) {
      case 'ready':
        if (!this.hasReceivedBuffer) {
          this.terminal?.clear();
        }
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.terminal?.focus();
        if (this.terminal) {
          this.sendResize(this.terminal.cols, this.terminal.rows);
        }
        break;

      case 'error':
        this.options.onStateChange?.(
          this._state,
          new Error(msg.message ?? 'Unknown error')
        );
        break;

      case 'exit':
        this.options.onStateChange?.(
          this._state,
          new Error(
            `Session exited with code ${msg.code}${msg.signal ? ` (${msg.signal})` : ''}`
          )
        );
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
      this.terminal?.clear();
      this.doConnect();
    }, delay + jitter);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private reconnectToNew(): void {
    this.cancelReconnect();
    this.closeSocket();
    this.reconnectAttempts = 0;

    if (!this.intentionalDisconnect && this.terminal) {
      this.terminal.clear();
      this.doConnect();
    }
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
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
