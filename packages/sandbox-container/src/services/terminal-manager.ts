import { existsSync } from 'node:fs';
import type { Logger, PtyOptions } from '@repo/shared';
import { CONFIG } from '../config';
import { Pty } from '../pty';

export interface TerminalHandle {
  id: string;
  pty: Pty;
}

export interface CreateTerminalOptions {
  id: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  pty?: PtyOptions;
}

class ManagedTerminal {
  constructor(readonly handle: TerminalHandle) {}

  async destroy(): Promise<void> {
    await this.handle.pty.destroy().catch(() => {});
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(private readonly logger: Logger) {}

  getTerminal(id: string): TerminalHandle | undefined {
    return this.terminals.get(id)?.handle;
  }

  async getOrCreateTerminal(
    options: CreateTerminalOptions
  ): Promise<TerminalHandle> {
    const existing = this.getTerminal(options.id);
    if (existing) {
      return existing;
    }

    const pty = new Pty({
      cwd: options.cwd ?? defaultTerminalCwd(),
      env: options.env,
      logger: this.logger
    });

    try {
      await pty.initialize(options.pty);
      const handle = { id: options.id, pty };
      this.terminals.set(options.id, new ManagedTerminal(handle));
      return handle;
    } catch (error) {
      await pty.destroy().catch(() => {});
      throw error;
    }
  }

  async destroyTerminal(id: string): Promise<void> {
    await this.terminals
      .get(id)
      ?.destroy()
      .catch(() => {});
    this.terminals.delete(id);
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.terminals.values()].map((terminal) => terminal.destroy())
    );
    this.terminals.clear();
  }
}

function defaultTerminalCwd(): string {
  if (existsSync(CONFIG.DEFAULT_CWD)) {
    return CONFIG.DEFAULT_CWD;
  }
  return process.cwd();
}
