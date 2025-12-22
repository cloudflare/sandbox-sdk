import {
  type CreatePtyOptions,
  getPtyExitInfo,
  type Logger,
  type PtyExitInfo,
  type PtyInfo,
  type PtyState
} from '@repo/shared';

/**
 * Minimal interface for Bun.Terminal (introduced in Bun v1.3.5+)
 * Defined locally since it's only used in the container runtime.
 * @types/bun doesn't include this yet, so we define it here.
 */
interface BunTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

interface BunTerminalOptions {
  cols: number;
  rows: number;
  data: (terminal: BunTerminal, data: Uint8Array) => void;
}

type BunTerminalConstructor = new (options: BunTerminalOptions) => BunTerminal;

export interface PtySession {
  id: string;
  sessionId?: string;
  terminal: BunTerminal;
  process: ReturnType<typeof Bun.spawn>;
  cols: number;
  rows: number;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  state: PtyState;
  exitCode?: number;
  exitInfo?: PtyExitInfo;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
  disconnectTimer?: Timer;
  disconnectTimeout: number;
  createdAt: Date;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private sessionToPty = new Map<string, string>(); // sessionId -> ptyId

  constructor(private logger: Logger) {}

  /** Maximum terminal dimensions (matches Daytona's limits) */
  private static readonly MAX_TERMINAL_SIZE = 1000;

  create(options: CreatePtyOptions & { sessionId?: string }): PtySession {
    const id = this.generateId();
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const command = options.command ?? ['/bin/bash'];
    const cwd = options.cwd ?? '/home/user';
    const env = options.env ?? {};
    const disconnectTimeout = options.disconnectTimeout ?? 30000;

    // Validate terminal dimensions
    if (cols > PtyManager.MAX_TERMINAL_SIZE || cols < 1) {
      throw new Error(
        `Invalid cols: ${cols}. Must be between 1 and ${PtyManager.MAX_TERMINAL_SIZE}`
      );
    }
    if (rows > PtyManager.MAX_TERMINAL_SIZE || rows < 1) {
      throw new Error(
        `Invalid rows: ${rows}. Must be between 1 and ${PtyManager.MAX_TERMINAL_SIZE}`
      );
    }

    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number) => void>();

    // Check if Bun.Terminal is available (introduced in Bun v1.3.5+)
    const BunTerminalClass = (Bun as { Terminal?: BunTerminalConstructor })
      .Terminal;
    if (!BunTerminalClass) {
      throw new Error(
        'Bun.Terminal is not available. Requires Bun v1.3.5 or higher.'
      );
    }

    // Capture logger for use in callbacks
    const logger = this.logger;

    const terminal = new BunTerminalClass({
      cols,
      rows,
      data: (_term: BunTerminal, data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        for (const cb of dataListeners) {
          try {
            cb(text);
          } catch (error) {
            // Log error so users can debug their onData handlers
            logger.error(
              'PTY data callback error - check your onData handler',
              error instanceof Error ? error : new Error(String(error)),
              { ptyId: id }
            );
          }
        }
      }
    });

    // Type assertion needed until @types/bun includes Terminal API (introduced in v1.3.5)
    const proc = Bun.spawn(command, {
      terminal,
      cwd,
      env: { TERM: 'xterm-256color', ...process.env, ...env }
    } as Parameters<typeof Bun.spawn>[1]);

    const session: PtySession = {
      id,
      sessionId: options.sessionId,
      terminal,
      process: proc,
      cols,
      rows,
      command,
      cwd,
      env,
      state: 'running',
      dataListeners,
      exitListeners,
      disconnectTimeout,
      createdAt: new Date()
    };

    // Track exit
    proc.exited
      .then((code) => {
        session.state = 'exited';
        session.exitCode = code;
        session.exitInfo = getPtyExitInfo(code);

        for (const cb of exitListeners) {
          try {
            cb(code);
          } catch (error) {
            // Log error so users can debug their onExit handlers
            logger.error(
              'PTY exit callback error - check your onExit handler',
              error instanceof Error ? error : new Error(String(error)),
              { ptyId: id, exitCode: code }
            );
          }
        }

        // Clear listeners to prevent memory leaks
        session.dataListeners.clear();
        session.exitListeners.clear();

        // Clean up session-to-pty mapping
        if (session.sessionId) {
          this.sessionToPty.delete(session.sessionId);
        }

        this.logger.debug('PTY exited', {
          ptyId: id,
          exitCode: code,
          exitInfo: session.exitInfo
        });
      })
      .catch((error) => {
        session.state = 'exited';
        session.exitCode = 1;
        session.exitInfo = {
          exitCode: 1,
          reason: error instanceof Error ? error.message : 'Process error'
        };

        // Clear listeners to prevent memory leaks
        session.dataListeners.clear();
        session.exitListeners.clear();

        // Clean up session-to-pty mapping
        if (session.sessionId) {
          this.sessionToPty.delete(session.sessionId);
        }

        this.logger.error(
          'PTY process error',
          error instanceof Error ? error : undefined,
          { ptyId: id, exitInfo: session.exitInfo }
        );
      });

    this.sessions.set(id, session);

    if (options.sessionId) {
      this.sessionToPty.set(options.sessionId, id);
    }

    this.logger.info('PTY created', { ptyId: id, command, cols, rows });

    return session;
  }

  get(id: string): PtySession | null {
    return this.sessions.get(id) ?? null;
  }

  getBySessionId(sessionId: string): PtySession | null {
    const ptyId = this.sessionToPty.get(sessionId);
    if (!ptyId) return null;
    return this.get(ptyId);
  }

  hasActivePty(sessionId: string): boolean {
    const pty = this.getBySessionId(sessionId);
    return pty !== null && pty.state === 'running';
  }

  list(): PtyInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.toInfo(s));
  }

  write(id: string, data: string): { success: boolean; error?: string } {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger.warn('Write to unknown PTY', { ptyId: id });
      return { success: false, error: 'PTY not found' };
    }
    if (session.state !== 'running') {
      this.logger.warn('Write to exited PTY', { ptyId: id });
      return { success: false, error: 'PTY has exited' };
    }
    try {
      session.terminal.write(data);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'PTY write failed',
        error instanceof Error ? error : undefined,
        { ptyId: id }
      );
      return { success: false, error: message };
    }
  }

  resize(
    id: string,
    cols: number,
    rows: number
  ): { success: boolean; error?: string } {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger.warn('Resize unknown PTY', { ptyId: id });
      return { success: false, error: 'PTY not found' };
    }
    if (session.state !== 'running') {
      this.logger.warn('Resize exited PTY', { ptyId: id });
      return { success: false, error: 'PTY has exited' };
    }
    // Validate dimensions
    if (
      cols > PtyManager.MAX_TERMINAL_SIZE ||
      cols < 1 ||
      rows > PtyManager.MAX_TERMINAL_SIZE ||
      rows < 1
    ) {
      this.logger.warn('Invalid resize dimensions', { ptyId: id, cols, rows });
      return {
        success: false,
        error: `Invalid dimensions. Must be between 1 and ${PtyManager.MAX_TERMINAL_SIZE}`
      };
    }
    try {
      session.terminal.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
      this.logger.debug('PTY resized', { ptyId: id, cols, rows });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'PTY resize failed',
        error instanceof Error ? error : undefined,
        { ptyId: id, cols, rows }
      );
      return { success: false, error: message };
    }
  }

  kill(id: string, signal?: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger.warn('Kill unknown PTY', { ptyId: id });
      return;
    }

    try {
      session.process.kill(signal === 'SIGKILL' ? 9 : 15);
      this.logger.info('PTY killed', { ptyId: id, signal });
    } catch (error) {
      this.logger.error(
        'Failed to kill PTY',
        error instanceof Error ? error : undefined,
        { ptyId: id }
      );
    }
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  onData(id: string, callback: (data: string) => void): () => void {
    const session = this.sessions.get(id);
    if (!session) {
      return () => {};
    }
    session.dataListeners.add(callback);
    return () => session.dataListeners.delete(callback);
  }

  onExit(id: string, callback: (code: number) => void): () => void {
    const session = this.sessions.get(id);
    if (!session) {
      return () => {};
    }

    // If already exited, call immediately
    if (session.state === 'exited' && session.exitCode !== undefined) {
      try {
        callback(session.exitCode);
      } catch {
        // Ignore callback errors to ensure registration completes
      }
      return () => {};
    }

    session.exitListeners.add(callback);
    return () => session.exitListeners.delete(callback);
  }

  startDisconnectTimer(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.cancelDisconnectTimer(id);

    session.disconnectTimer = setTimeout(() => {
      try {
        this.logger.info('PTY disconnect timeout, killing', { ptyId: id });
        this.kill(id);
      } catch {
        // Ignore errors to prevent timer callback from crashing
      }
    }, session.disconnectTimeout);
  }

  cancelDisconnectTimer(id: string): void {
    const session = this.sessions.get(id);
    if (!session?.disconnectTimer) return;

    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = undefined;
  }

  cleanup(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.cancelDisconnectTimer(id);

    if (session.sessionId) {
      this.sessionToPty.delete(session.sessionId);
    }

    this.sessions.delete(id);
    this.logger.debug('PTY cleaned up', { ptyId: id });
  }

  private generateId(): string {
    return `pty_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private toInfo(session: PtySession): PtyInfo {
    return {
      id: session.id,
      sessionId: session.sessionId,
      cols: session.cols,
      rows: session.rows,
      command: session.command,
      cwd: session.cwd,
      createdAt: session.createdAt.toISOString(),
      state: session.state,
      exitCode: session.exitCode,
      exitInfo: session.exitInfo
    };
  }
}
