import type {
  Disposable,
  Logger,
  PtyControlMessage,
  PtyStatusMessage
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import type { Pty } from '../pty';
import type { SessionManager } from '../services/session-manager';

export interface PtyWSData {
  type: 'pty';
  sessionId: string;
  connectionId: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

interface PtyConnection {
  ws: ServerWebSocket<PtyWSData>;
  pty: Pty;
  subscription: Disposable;
}

export class PtyWebSocketHandler {
  private connections = new Map<string, PtyConnection>();

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger
  ) {}

  async onOpen(ws: ServerWebSocket<PtyWSData>): Promise<void> {
    const { sessionId, connectionId, cols, rows, shell } = ws.data;
    // Lifecycle captured in onClose canonical log line

    const result = await this.sessionManager.getPty(sessionId, {
      cols,
      rows,
      shell
    });

    if (!result.success) {
      this.sendStatus(ws, {
        type: 'error',
        message: result.error.message
      });
      ws.close(1011, result.error.message);
      return;
    }

    const pty = result.data;

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
      this.sendPtyData(ws, connectionId, data);
    });

    this.connections.set(connectionId, { ws, pty, subscription });

    this.sendStatus(ws, { type: 'ready' });
  }

  onMessage(
    ws: ServerWebSocket<PtyWSData>,
    message: string | ArrayBuffer | Buffer
  ): void {
    const { connectionId } = ws.data;
    const conn = this.connections.get(connectionId);

    if (!conn) {
      this.logger.warn('pty.message', {
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

  onClose(ws: ServerWebSocket<PtyWSData>, code: number, reason: string): void {
    const { connectionId, sessionId } = ws.data;

    this.logger.debug('pty.connection', {
      sessionId,
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

  onDrain(ws: ServerWebSocket<PtyWSData>): void {
    const { connectionId } = ws.data;
    this.logger.debug('pty.drain', { connectionId });
  }

  private sendPtyData(
    ws: ServerWebSocket<PtyWSData>,
    connectionId: string,
    data: Uint8Array
  ): void {
    const result = ws.sendBinary(data);

    if (result === 0) {
      this.logger.debug('pty.send', { connectionId, outcome: 'dead' });
      const conn = this.connections.get(connectionId);
      if (conn) {
        conn.subscription.dispose();
        this.connections.delete(connectionId);
      }
    }
  }

  private handleControl(
    pty: Pty,
    ws: ServerWebSocket<PtyWSData>,
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
        this.logger.warn('pty.control', {
          connectionId: ws.data.connectionId,
          controlType: control.type,
          outcome: 'unknown_type'
        });
      }
    } catch (err) {
      this.logger.error('pty.control', err as Error, {
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
    ws: ServerWebSocket<PtyWSData>,
    status: PtyStatusMessage
  ): void {
    try {
      ws.send(JSON.stringify(status));
    } catch (err) {
      this.logger.error('pty.sendStatus', err as Error);
    }
  }
}
