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
  private readonly terminalCreations = new Map<
    string,
    Promise<ManagedTerminal>
  >();

  constructor(private readonly logger: Logger) {}

  getTerminal(id: string): TerminalHandle | undefined {
    const terminal = this.terminals.get(id);
    if (terminal?.handle.pty.closed) {
      this.terminals.delete(id);
      return undefined;
    }
    return terminal?.handle;
  }

  protected async createManagedTerminal(
    options: CreateTerminalOptions
  ): Promise<ManagedTerminal> {
    const pty = new Pty({
      cwd: options.cwd ?? defaultTerminalCwd(),
      env: options.env,
      logger: this.logger,
      onExit: () => {
        // Remove this PTY's entry only if it is still the current one,
        // guarding against a replacement terminal with the same ID.
        const current = this.terminals.get(options.id);
        if (current?.handle.pty === pty) {
          this.terminals.delete(options.id);
        }
      }
    });

    try {
      await pty.initialize(options.pty);
      const handle = { id: options.id, pty };
      return new ManagedTerminal(handle);
    } catch (error) {
      await pty.destroy().catch(() => {});
      throw error;
    }
  }

  async getOrCreateTerminal(
    options: CreateTerminalOptions
  ): Promise<TerminalHandle> {
    const existing = this.terminals.get(options.id);
    if (existing && !existing.handle.pty.closed) {
      return existing.handle;
    }
    if (existing?.handle.pty.closed) {
      this.terminals.delete(options.id);
    }

    const pending = this.terminalCreations.get(options.id);
    if (pending) {
      return (await pending).handle;
    }

    const creation = this.createManagedTerminal(options);
    this.terminalCreations.set(options.id, creation);
    try {
      const managed = await creation;
      this.terminals.set(options.id, managed);
      return managed.handle;
    } finally {
      this.terminalCreations.delete(options.id);
    }
  }

  async destroyTerminal(id: string): Promise<void> {
    // Wait for any in-flight creation so it can be cleaned up immediately after.
    const pending = this.terminalCreations.get(id);
    if (pending) {
      await pending.catch(() => {});
    }
    await this.terminals
      .get(id)
      ?.destroy()
      .catch(() => {});
    this.terminals.delete(id);
  }

  async destroyAll(): Promise<void> {
    // Drain in-flight creations before clearing so no creation can repopulate
    // terminals after the clear completes.
    await Promise.all(
      [...this.terminalCreations.values()].map((p) => p.catch(() => {}))
    );
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
