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
    const { sessionId, connectionId, cols, rows } = ws.data;

    this.logger.debug('PTY WebSocket opened', { sessionId, connectionId });

    const result = await this.sessionManager.getPty(sessionId, { cols, rows });

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
      this.logger.warn('Message for unknown PTY connection', { connectionId });
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

    this.logger.debug('PTY WebSocket closed', {
      sessionId,
      connectionId,
      code,
      reason
    });

    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.subscription.dispose();
      this.connections.delete(connectionId);
    }
  }

  onDrain(ws: ServerWebSocket<PtyWSData>): void {
    const { connectionId } = ws.data;
    this.logger.debug('PTY WebSocket drained', { connectionId });
  }

  private sendPtyData(
    ws: ServerWebSocket<PtyWSData>,
    connectionId: string,
    data: Uint8Array
  ): void {
    const result = ws.sendBinary(data);

    if (result === 0) {
      this.logger.debug('PTY send failed - connection dead', { connectionId });
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
        this.logger.warn('Unknown PTY control message', { control });
      }
    } catch (err) {
      this.logger.error('Failed to parse PTY control message', err as Error);
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
      this.logger.error('Failed to send PTY status', err as Error);
    }
  }
}
