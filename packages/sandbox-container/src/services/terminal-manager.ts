import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, PtyOptions } from '@repo/shared';
import { CONFIG } from '../config';
import { Pty } from '../pty';
import type { RawExecResult } from '../session-types';

export interface TerminalStateSession {
  exec(
    command: string,
    options?: { origin?: 'user' | 'internal' }
  ): Promise<RawExecResult>;
}

export interface TerminalHandle {
  id: string;
  sessionId: string;
  pty: Pty;
}

class SessionTerminal {
  private handle: TerminalHandle | null = null;

  constructor(
    private readonly id: string,
    private readonly sessionId: string,
    private readonly logger: Logger
  ) {}

  async getTerminal(
    session: TerminalStateSession,
    options?: PtyOptions
  ): Promise<TerminalHandle> {
    if (this.handle) {
      return this.handle;
    }

    // Capture the session shell's current environment and working
    // directory so the PTY inherits env vars set via setEnvVars()
    // and reflects any directory changes made in the session.
    //
    // Captures env output to a temp file. The exec pipeline's
    // `read`-based labeling strips \0 from stdout, so reading
    // the file directly with Bun preserves the null-byte delimiters.
    const sessionEnv: Record<string, string> = {};
    let sessionCwd: string = CONFIG.DEFAULT_CWD;
    const safeId = this.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempEnvFile = join(tmpdir(), `pty-env-${safeId}-${Date.now()}`);
    try {
      const envResult = await session.exec(`env -0 > '${tempEnvFile}'`, {
        origin: 'internal'
      });
      if (envResult.exitCode === 0) {
        const envText = await Bun.file(tempEnvFile).text();
        for (const entry of envText.split('\0')) {
          const idx = entry.indexOf('=');
          if (idx > 0) {
            sessionEnv[entry.slice(0, idx)] = entry.slice(idx + 1);
          }
        }
      }

      const cwdResult = await session.exec('pwd', { origin: 'internal' });
      if (cwdResult.exitCode === 0 && cwdResult.stdout?.trim()) {
        sessionCwd = cwdResult.stdout.trim();
      }
    } catch {
      this.logger.warn('Failed to capture session state for PTY', {
        sessionId: this.sessionId
      });
    } finally {
      await rm(tempEnvFile, { force: true }).catch(() => {});
    }

    const pty = new Pty({
      cwd: sessionCwd,
      env: sessionEnv,
      logger: this.logger
    });

    try {
      await pty.initialize(options);
      const handle = {
        id: this.id,
        sessionId: this.sessionId,
        pty
      };
      this.handle = handle;
      return handle;
    } catch (error) {
      await pty.destroy().catch(() => {});
      throw error;
    }
  }

  async destroy(): Promise<void> {
    await this.handle?.pty.destroy().catch(() => {});
    this.handle = null;
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, SessionTerminal>();

  constructor(private readonly logger: Logger) {}

  async getTerminal(
    terminalId: string,
    sessionId: string,
    session: TerminalStateSession,
    options?: PtyOptions
  ): Promise<TerminalHandle> {
    let terminal = this.terminals.get(terminalId);
    if (!terminal) {
      terminal = new SessionTerminal(terminalId, sessionId, this.logger);
      this.terminals.set(terminalId, terminal);
    }

    return terminal.getTerminal(session, options);
  }

  async getPty(
    sessionId: string,
    session: TerminalStateSession,
    options?: PtyOptions
  ): Promise<Pty> {
    const terminal = await this.getTerminal(
      sessionId,
      sessionId,
      session,
      options
    );
    return terminal.pty;
  }

  async destroyTerminal(terminalId: string): Promise<void> {
    await this.terminals
      .get(terminalId)
      ?.destroy()
      .catch(() => {});
    this.terminals.delete(terminalId);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.terminals.values()].map((terminal) => terminal.destroy())
    );
    this.terminals.clear();
  }
}
