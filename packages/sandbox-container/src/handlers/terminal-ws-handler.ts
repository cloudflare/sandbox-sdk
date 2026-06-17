import type {
  Disposable,
  Logger,
  PtyControlMessage,
  PtyStatusMessage
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import type { Pty } from '../pty';
import type { TerminalManager } from '../services/terminal-manager';

export interface TerminalWSData {
  type: 'terminal';
  terminalId: string;
  connectionId: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

interface TerminalConnection {
  ws: ServerWebSocket<TerminalWSData>;
  pty: Pty;
  subscription: Disposable;
}

export class TerminalWebSocketHandler {
  private connections = new Map<string, TerminalConnection>();

  constructor(
    private terminalManager: Pick<TerminalManager, 'getOrCreateTerminal'>,
    private logger: Logger
  ) {}

  async onOpen(ws: ServerWebSocket<TerminalWSData>): Promise<void> {
    const { terminalId, connectionId, cols, rows, shell } = ws.data;
    // Lifecycle captured in onClose canonical log line

    let pty: Pty;
    try {
      const terminal = await this.terminalManager.getOrCreateTerminal({
        id: terminalId,
        pty: { cols, rows, shell }
      });
      pty = terminal.pty;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendStatus(ws, {
        type: 'error',
        message
      });
      ws.close(1011, message);
      return;
    }

    const bufferedOutput = pty.getBufferedOutput();
    if (bufferedOutput.length > 0) {
      const sendResult = ws.sendBinary(bufferedOutput);
      if (sendResult === 0) {
        this.logger.warn('Failed to send buffered output - connection dead', {
          connectionId
        });
        ws.close(1011, 'Send failed');
        return;
      }
    }

    const subscription = pty.onData((data) => {
      this.sendTerminalData(ws, connectionId, data);
    });

    this.connections.set(connectionId, { ws, pty, subscription });

    this.sendStatus(ws, { type: 'ready' });
  }

  onMessage(
    ws: ServerWebSocket<TerminalWSData>,
    message: string | ArrayBuffer | Buffer
  ): void {
    const { connectionId } = ws.data;
    const conn = this.connections.get(connectionId);

    if (!conn) {
      this.logger.warn('terminal.message', {
        connectionId,
        outcome: 'unknown_connection'
      });
      return;
    }

    if (typeof message === 'string') {
      this.handleControl(conn.pty, ws, message);
    } else {
      conn.pty.write(new Uint8Array(message));
    }
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

    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.subscription.dispose();
      this.connections.delete(connectionId);
    }
  }

  onDrain(ws: ServerWebSocket<TerminalWSData>): void {
    const { connectionId } = ws.data;
    this.logger.debug('terminal.drain', { connectionId });
  }

  private sendTerminalData(
    ws: ServerWebSocket<TerminalWSData>,
    connectionId: string,
    data: Uint8Array
  ): void {
    const result = ws.sendBinary(data);

    if (result === 0) {
      this.logger.debug('terminal.send', { connectionId, outcome: 'dead' });
      const conn = this.connections.get(connectionId);
      if (conn) {
        conn.subscription.dispose();
        this.connections.delete(connectionId);
      }
    }
  }

  private handleControl(
    pty: Pty,
    ws: ServerWebSocket<TerminalWSData>,
    message: string
  ): void {
    try {
      const control = JSON.parse(message) as PtyControlMessage;

      if (control.type === 'resize') {
        if (control.cols <= 0 || control.rows <= 0) {
          this.sendStatus(ws, {
            type: 'error',
            message: 'Invalid dimensions: cols and rows must be positive'
          });
          return;
        }
        pty.resize(control.cols, control.rows);
      } else {
        this.logger.warn('terminal.control', {
          connectionId: ws.data.connectionId,
          controlType: control.type,
          outcome: 'unknown_type'
        });
      }
    } catch (err) {
      this.logger.error('terminal.control', err as Error, {
        connectionId: ws.data.connectionId,
        outcome: 'parse_error'
      });
      this.sendStatus(ws, {
        type: 'error',
        message: 'Invalid control message'
      });
    }
  }

  private sendStatus(
    ws: ServerWebSocket<TerminalWSData>,
    status: PtyStatusMessage
  ): void {
    try {
      ws.send(JSON.stringify(status));
    } catch (err) {
      this.logger.error('terminal.sendStatus', err as Error);
    }
  }
}
