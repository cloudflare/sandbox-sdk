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

class SessionTerminal {
  private pty: Pty | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly logger: Logger
  ) {}

  async getPty(
    session: TerminalStateSession,
    options?: PtyOptions
  ): Promise<Pty> {
    if (this.pty) {
      return this.pty;
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
      this.pty = pty;
      return pty;
    } catch (error) {
      await pty.destroy().catch(() => {});
      throw error;
    }
  }

  async destroy(): Promise<void> {
    await this.pty?.destroy().catch(() => {});
    this.pty = null;
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, SessionTerminal>();

  constructor(private readonly logger: Logger) {}

  async getPty(
    sessionId: string,
    session: TerminalStateSession,
    options?: PtyOptions
  ): Promise<Pty> {
    let terminal = this.terminals.get(sessionId);
    if (!terminal) {
      terminal = new SessionTerminal(sessionId, this.logger);
      this.terminals.set(sessionId, terminal);
    }

    return terminal.getPty(session, options);
  }

  async destroyTerminal(sessionId: string): Promise<void> {
    await this.terminals
      .get(sessionId)
      ?.destroy()
      .catch(() => {});
    this.terminals.delete(sessionId);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.terminals.values()].map((terminal) => terminal.destroy())
    );
    this.terminals.clear();
  }
}
