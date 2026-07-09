import type {
  RuntimeTerminalOutputEvent,
  RuntimeTerminalProcess
} from '@repo/sandbox-execution';
import type {
  Logger,
  PtyClientControlMessage,
  PtyServerControlMessage
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import type { TerminalManager } from '../services/terminal-manager';

export interface TerminalWSData {
  type: 'terminal';
  terminalId: string;
  connectionId: string;
  cursor?: string;
  cols?: number;
  rows?: number;
}

interface TerminalOutputReader {
  read(): Promise<
    | { done: true; value?: RuntimeTerminalOutputEvent }
    | { done: false; value: RuntimeTerminalOutputEvent }
  >;
  cancel(): Promise<void>;
}

interface TerminalConnection {
  ws: ServerWebSocket<TerminalWSData>;
  pty: RuntimeTerminalProcess;
  reader: TerminalOutputReader;
}

export class TerminalWebSocketHandler {
  private connections = new Map<string, TerminalConnection>();

  constructor(
    private terminalManager: Pick<TerminalManager, 'getTerminal'>,
    private logger: Logger
  ) {}

  async onOpen(ws: ServerWebSocket<TerminalWSData>): Promise<void> {
    const { terminalId, connectionId, cursor, cols, rows } = ws.data;
    const terminal = this.terminalManager.getTerminal(terminalId);
    if (!terminal) {
      this.sendControl(ws, { type: 'error', message: 'Terminal not found' });
      ws.close(1008, 'Terminal not found');
      return;
    }

    const { pty } = terminal;
    try {
      if (cols !== undefined && rows !== undefined) pty.resize(cols, rows);
      const reader = pty
        .output({ after: cursor, replay: true, follow: true })
        .getReader();
      this.connections.set(connectionId, { ws, pty, reader });
      if (!this.sendControl(ws, { type: 'ready', cursor })) {
        this.closeAfterSendFailure(ws);
        return;
      }
      this.forwardOutput(connectionId, reader);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendControl(ws, { type: 'error', message });
      ws.close(1011, message);
    }
  }

  onMessage(
    ws: ServerWebSocket<TerminalWSData>,
    message: string | ArrayBuffer | Buffer
  ): void {
    const conn = this.connections.get(ws.data.connectionId);
    if (!conn) return;
    if (typeof message === 'string') this.handleControl(conn.pty, ws, message);
    else
      conn.pty.write(new Uint8Array(message)).catch((error: Error) =>
        this.logger.error('terminal.write', error, {
          connectionId: ws.data.connectionId
        })
      );
  }

  onClose(
    ws: ServerWebSocket<TerminalWSData>,
    code: number,
    reason: string
  ): void {
    const { connectionId, terminalId } = ws.data;
    this.logger.debug('terminal.connection', {
      terminalId,
      connectionId,
      code,
      reason,
      outcome: 'closed'
    });
    this.disconnect(connectionId);
  }

  onDrain(ws: ServerWebSocket<TerminalWSData>): void {
    this.logger.debug('terminal.drain', { connectionId: ws.data.connectionId });
  }

  private async forwardOutput(
    connectionId: string,
    reader: TerminalOutputReader
  ): Promise<void> {
    try {
      while (this.connections.get(connectionId)?.reader === reader) {
        const result = await reader.read();
        if (result.done) {
          this.closeCompletedConnection(connectionId);
          break;
        }
        const keepOpen = this.sendOutputEvent(connectionId, result.value);
        if (!keepOpen || result.value.type === 'terminal') break;
      }
    } catch (error) {
      this.logger.error('terminal.output', toError(error), { connectionId });
    } finally {
      this.disconnect(connectionId);
    }
  }

  private sendOutputEvent(
    connectionId: string,
    event: RuntimeTerminalOutputEvent
  ): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;
    if (event.type === 'data') {
      if (
        !this.sendControl(conn.ws, {
          type: 'chunk',
          cursor: event.cursor,
          byteLength: event.data.byteLength
        })
      ) {
        this.closeAfterSendFailure(conn.ws);
        return false;
      }
      return this.sendBinary(connectionId, event.data);
    }
    if (event.type === 'truncated') {
      const sent = this.sendControl(conn.ws, {
        type: 'truncated',
        cursor: event.cursor
      });
      if (!sent) this.closeAfterSendFailure(conn.ws);
      return sent;
    }
    if (event.state === 'error') {
      const sent = this.sendControl(conn.ws, {
        type: 'error',
        cursor: event.cursor,
        code: event.error.code,
        message: event.error.message
      });
      conn.ws.close(1011, 'Terminal error');
      return sent;
    }
    const sent = this.sendControl(conn.ws, {
      type: 'exit',
      cursor: event.cursor,
      exit: event.exit
    });
    conn.ws.close(1000, 'Terminal exited');
    return sent;
  }

  private sendBinary(connectionId: string, data: Uint8Array): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;
    try {
      const result = conn.ws.sendBinary(data);
      if (result === 0 || result === -1) {
        conn.ws.close(1013, 'Terminal client backpressure');
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error('terminal.sendBinary', toError(error), {
        connectionId
      });
      conn.ws.close(1011, 'Terminal send failed');
      return false;
    }
  }

  private closeCompletedConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.ws.close(1000, 'Terminal output complete');
  }

  private closeAfterSendFailure(ws: ServerWebSocket<TerminalWSData>): void {
    ws.close(1011, 'Terminal send failed');
    this.disconnect(ws.data.connectionId);
  }

  private handleControl(
    pty: RuntimeTerminalProcess,
    ws: ServerWebSocket<TerminalWSData>,
    message: string
  ): void {
    try {
      const control = JSON.parse(message);
      if (!isClientControlMessage(control)) {
        if (
          !this.sendControl(ws, {
            type: 'error',
            message: 'Invalid control message'
          })
        ) {
          this.closeAfterSendFailure(ws);
        }
        return;
      }
      if (control.type === 'resize') pty.resize(control.cols, control.rows);
      else if (control.type === 'interrupt') void pty.interrupt();
      else void pty.terminate();
    } catch (error) {
      this.logger.error('terminal.control', toError(error), {
        connectionId: ws.data.connectionId
      });
      if (
        !this.sendControl(ws, {
          type: 'error',
          message: 'Invalid control message'
        })
      ) {
        this.closeAfterSendFailure(ws);
      }
    }
  }

  private sendControl(
    ws: ServerWebSocket<TerminalWSData>,
    status: PtyServerControlMessage
  ): boolean {
    try {
      const result = ws.send(JSON.stringify(status));
      return result !== 0 && result !== -1;
    } catch (error) {
      this.logger.error('terminal.sendControl', toError(error));
      return false;
    }
  }

  private disconnect(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.reader.cancel().catch(() => {});
    this.connections.delete(connectionId);
  }
}

function isClientControlMessage(
  value: unknown
): value is PtyClientControlMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  if (value.type === 'interrupt' || value.type === 'terminate') return true;
  return (
    value.type === 'resize' &&
    'cols' in value &&
    'rows' in value &&
    typeof value.cols === 'number' &&
    typeof value.rows === 'number' &&
    value.cols > 0 &&
    value.rows > 0
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
