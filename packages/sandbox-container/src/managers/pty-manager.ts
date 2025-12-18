import type { CreatePtyOptions, Logger, PtyInfo, PtyState } from '@repo/shared';

export interface PtySession {
  id: string;
  sessionId?: string;
  terminal: any; // Bun.Terminal type not available in older @types/bun
  process: ReturnType<typeof Bun.spawn>;
  cols: number;
  rows: number;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  state: PtyState;
  exitCode?: number;
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

  create(options: CreatePtyOptions & { sessionId?: string }): PtySession {
    const id = this.generateId();
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const command = options.command ?? ['bash'];
    const cwd = options.cwd ?? '/home/user';
    const env = options.env ?? {};
    const disconnectTimeout = options.disconnectTimeout ?? 30000;

    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number) => void>();

    // Check if Bun.Terminal is available (introduced in Bun v1.3.5+)
    const BunTerminal = (Bun as any).Terminal;
    if (!BunTerminal) {
      throw new Error(
        'Bun.Terminal is not available. Requires Bun v1.3.5 or higher.'
      );
    }

    const terminal = new BunTerminal({
      cols,
      rows,
      data: (_term: any, data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        for (const cb of dataListeners) {
          cb(text);
        }
      }
    });

    // Type assertion needed until @types/bun includes Terminal API (introduced in v1.3.5)
    const proc = Bun.spawn(command, {
      terminal,
      cwd,
      env: { ...process.env, ...env }
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
    proc.exited.then((code) => {
      session.state = 'exited';
      session.exitCode = code;
      for (const cb of exitListeners) {
        cb(code);
      }

      // Clean up session-to-pty mapping
      if (session.sessionId) {
        this.sessionToPty.delete(session.sessionId);
      }

      this.logger.debug('PTY exited', { ptyId: id, exitCode: code });
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

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger.warn('Write to unknown PTY', { ptyId: id });
      return;
    }
    if (session.state !== 'running') {
      this.logger.warn('Write to exited PTY', { ptyId: id });
      return;
    }
    session.terminal.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      this.logger.warn('Resize unknown PTY', { ptyId: id });
      return;
    }
    session.terminal.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    this.logger.debug('PTY resized', { ptyId: id, cols, rows });
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
      callback(session.exitCode);
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
      this.logger.info('PTY disconnect timeout, killing', { ptyId: id });
      this.kill(id);
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
      exitCode: session.exitCode
    };
  }
}
