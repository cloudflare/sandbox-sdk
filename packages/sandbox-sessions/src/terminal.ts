const DEFAULT_TIMEOUT_MS = 2_000;

type TerminalState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

export class Terminal implements AsyncDisposable {
  private readonly terminal: Bun.Terminal;
  private readonly shell: Bun.Subprocess;
  private readonly decoder = new TextDecoder();
  private readonly ready = Promise.withResolvers<void>();
  private state: TerminalState = 'starting';
  private transcript = '';
  private cleanupPromise?: Promise<void>;

  private constructor(options: {
    terminal: Bun.Terminal;
    shell: Bun.Subprocess;
  }) {
    this.terminal = options.terminal;
    this.shell = options.shell;
    this.ready.promise.catch(() => {});
    this.shell.exited.then(() => {
      if (this.state !== 'closing' && this.state !== 'closed') {
        this.state = 'failed';
      }
    });
  }

  static async create(
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<Terminal> {
    let terminalSession: Terminal | undefined;
    const shell = Bun.spawn(['bash', '--noprofile', '--norc', '-i'], {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, data) => {
          terminalSession?.appendData(data);
        }
      },
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        HISTFILE: '',
        TERM: 'xterm-256color',
        PS1: 'sandbox$ '
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    });

    const terminal = shell.terminal;
    if (!terminal) {
      throw new Error('Terminal shell did not expose a PTY');
    }
    terminal.unref();

    terminalSession = new Terminal({ terminal, shell });
    await terminalSession.waitForReady();
    return terminalSession;
  }

  write(data: string | Uint8Array): number {
    if (this.state === 'closed' || this.state === 'closing') {
      throw new Error('Terminal is closed');
    }
    return this.terminal.write(data);
  }

  capture(): string {
    return this.transcript;
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closing';
    await this.cleanupResources();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async waitForReady(): Promise<void> {
    await Promise.race([
      this.ready.promise,
      Bun.sleep(DEFAULT_TIMEOUT_MS).then(() => {
        throw new Error('Timed out waiting for terminal readiness');
      })
    ]);
  }

  private appendData(data: Uint8Array): void {
    this.transcript += this.decoder.decode(data, { stream: true });
    if (this.state === 'starting' && this.transcript.includes('sandbox$ ')) {
      this.state = 'ready';
      this.ready.resolve();
    }
  }

  private cleanupResources(): Promise<void> {
    this.cleanupPromise ??= this.cleanupResourcesOnce();
    return this.cleanupPromise;
  }

  private async cleanupResourcesOnce(): Promise<void> {
    try {
      this.terminal.close();
    } catch {}
    try {
      this.shell.kill('SIGTERM');
    } catch {}
    await Promise.race([this.shell.exited, Bun.sleep(500)]);
    this.state = 'closed';
  }
}
