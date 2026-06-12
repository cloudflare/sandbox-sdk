import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRcFileContent,
  type ProtocolFrame,
  parseTerminalChunk
} from './protocol';

const COMMAND_FD = 4;

type SessionState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

export type ExecResult = {
  exitCode: number;
  transcript: string;
};

type PendingExec = {
  id: string;
  transcriptStart: number;
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class TerminalSession implements AsyncDisposable {
  private readonly terminal: Bun.Terminal;
  private readonly shell: Bun.Subprocess;
  private readonly tempDir: string;
  private readonly commandFifoPath: string;
  private readonly nonce: string;
  private commandWriter?: ReturnType<typeof Bun.file.prototype.writer>;
  private readonly decoder = new TextDecoder();
  private readonly ready = Promise.withResolvers<void>();
  private state: SessionState = 'starting';
  private transcript = '';
  private protocolBuffer = '';
  private pendingExec?: PendingExec;
  private failure?: Error;
  private cleanupPromise?: Promise<void>;
  private operationQueue: Promise<ExecResult> = Promise.resolve({
    exitCode: 0,
    transcript: ''
  });

  private constructor(options: {
    terminal: Bun.Terminal;
    shell: Bun.Subprocess;
    tempDir: string;
    commandFifoPath: string;
    nonce: string;
  }) {
    this.terminal = options.terminal;
    this.shell = options.shell;
    this.tempDir = options.tempDir;
    this.commandFifoPath = options.commandFifoPath;
    this.nonce = options.nonce;
    this.ready.promise.catch(() => {});
    this.shell.exited.then((exitCode) => {
      if (
        this.state !== 'closing' &&
        this.state !== 'closed' &&
        this.state !== 'failed'
      ) {
        this.fail(
          new Error(
            `Terminal session shell exited with code ${exitCode}. Transcript: ${JSON.stringify(this.transcript)}`
          )
        );
      }
    });
  }

  static async create(
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<TerminalSession> {
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const tempDir = await mkdtemp(join(tmpdir(), 'terminal-session-'));
    const rcPath = join(tempDir, 'bashrc');
    const commandFifoPath = join(tempDir, 'commands');
    let session: TerminalSession | undefined;

    try {
      await writeFile(rcPath, createRcFileContent());
      const mkfifo = Bun.spawn(['mkfifo', commandFifoPath]);
      const mkfifoExitCode = await mkfifo.exited;
      if (mkfifoExitCode !== 0) {
        throw new Error(`Failed to create command FIFO at ${commandFifoPath}`);
      }

      const earlyData: Uint8Array[] = [];
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data: (_terminal, data) => {
          const chunk = new Uint8Array(data);
          if (session) {
            session.appendTerminalData(chunk);
          } else {
            earlyData.push(chunk);
          }
        }
      });
      terminal.unref();

      const shell = Bun.spawn(
        ['bash', '--noprofile', '--rcfile', rcPath, '-i'],
        {
          terminal,
          cwd: options.cwd,
          env: {
            ...process.env,
            ...options.env,
            TERM: 'xterm-256color',
            HISTFILE: '',
            TERMINAL_SESSION_NONCE: nonce,
            TERMINAL_SESSION_CMD_FD: String(COMMAND_FD),
            TERMINAL_SESSION_CMD_FIFO: commandFifoPath
          }
        }
      );

      session = new TerminalSession({
        terminal,
        shell,
        tempDir,
        commandFifoPath,
        nonce
      });

      for (const chunk of earlyData) {
        session.appendTerminalData(chunk);
      }

      await session.waitForReady();
      return session;
    } catch (error) {
      if (session) {
        await session.close();
      } else {
        await rm(tempDir, { force: true, recursive: true });
      }
      throw error;
    }
  }

  async exec(
    command: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const run = async (): Promise<ExecResult> =>
      this.execNow(command, options.timeoutMs ?? 2_000);
    const result = this.operationQueue.then(run, run);
    this.operationQueue = result.catch(() => ({ exitCode: 1, transcript: '' }));
    return result;
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    if (!this.failure) {
      this.failure = new Error('Terminal session is closed');
      this.ready.reject(this.failure);
      this.rejectPendingExec(this.failure);
    }
    await this.cleanupResources();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private waitForReady(): Promise<void> {
    return Promise.race([
      this.ready.promise,
      Bun.sleep(2_000).then(() => {
        throw new Error(
          `Timed out waiting for terminal session shell readiness. Transcript: ${JSON.stringify(this.transcript)} Protocol: ${JSON.stringify(this.protocolBuffer)}`
        );
      })
    ]);
  }

  private async execNow(
    command: string,
    timeoutMs: number
  ): Promise<ExecResult> {
    this.assertReadyForExec();

    const id = crypto.randomUUID().replaceAll('-', '');
    this.transcript = '';
    const transcriptStart = 0;
    const encodedCommand = Buffer.from(command).toString('base64');

    const result = new Promise<ExecResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Timed out waiting for exec ${id}`);
        this.fail(error);
        void this.cleanupResources();
      }, timeoutMs);
      this.pendingExec = { id, transcriptStart, resolve, reject, timeout };
    });

    const writer = this.ensureCommandWriter();
    writer.write(`${id}|${encodedCommand}\n`);
    await writer.flush();
    try {
      process.kill(this.shell.pid, 'SIGWINCH');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Terminal session wakeup failed: ${message}`);
      this.fail(failure);
      void this.cleanupResources();
      throw failure;
    }

    return result;
  }

  private assertReadyForExec(): void {
    if (this.state === 'closed' || this.state === 'closing') {
      throw new Error('Terminal session is closed');
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.state !== 'ready') {
      throw new Error(`Terminal session is ${this.state}`);
    }
    if (this.pendingExec) {
      throw new Error('Terminal session already has a pending exec');
    }
  }

  private ensureCommandWriter(): ReturnType<typeof Bun.file.prototype.writer> {
    if (!this.commandWriter) {
      this.commandWriter = Bun.file(this.commandFifoPath).writer();
    }
    return this.commandWriter;
  }

  private appendTerminalData(data: Uint8Array): void {
    const parsed = parseTerminalChunk({
      buffered: this.protocolBuffer,
      chunk: this.decoder.decode(data, { stream: true }),
      nonce: this.nonce
    });
    this.protocolBuffer = parsed.buffered;
    for (const event of parsed.events) {
      if (event.kind === 'text') {
        this.transcript += event.value;
      } else {
        this.handleFrame(event.frame);
      }
    }
  }

  private handleFrame(frame: ProtocolFrame): void {
    if (frame.type === 'READY') {
      if (this.state === 'starting') {
        this.state = 'ready';
        this.ready.resolve();
      }
      return;
    }

    if (frame.type !== 'EXEC_DONE' || !this.pendingExec) {
      return;
    }
    if (frame.id !== this.pendingExec.id) {
      return;
    }

    const pending = this.pendingExec;
    this.pendingExec = undefined;
    clearTimeout(pending.timeout);
    const exitCode = Number.parseInt(frame.payload, 10);
    pending.resolve({
      exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
      transcript: this.transcript.slice(pending.transcriptStart)
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.state !== 'closing' && this.state !== 'closed') {
      this.state = 'failed';
    }
    this.ready.reject(error);
    this.rejectPendingExec(error);
  }

  private rejectPendingExec(error: Error): void {
    if (this.pendingExec) {
      clearTimeout(this.pendingExec.timeout);
      this.pendingExec.reject(error);
      this.pendingExec = undefined;
    }
  }

  private cleanupResources(): Promise<void> {
    this.cleanupPromise ??= this.cleanupResourcesOnce();
    return this.cleanupPromise;
  }

  private async cleanupResourcesOnce(): Promise<void> {
    const failed = this.state === 'failed';
    if (!failed) {
      this.state = 'closing';
    }

    if (this.commandWriter) {
      try {
        await this.commandWriter.end();
      } catch {}
      this.commandWriter = undefined;
    }

    try {
      this.shell.kill('SIGTERM');
    } catch {}
    try {
      this.shell.unref();
    } catch {}
    const exited = await Promise.race([
      this.shell.exited.then(() => true),
      Bun.sleep(500).then(() => false)
    ]);
    if (!exited) {
      try {
        this.shell.kill('SIGKILL');
      } catch {}
      await Promise.race([this.shell.exited, Bun.sleep(500)]);
    }

    try {
      this.terminal.close();
    } catch {}
    try {
      this.terminal.unref();
    } catch {}

    await rm(this.tempDir, { force: true, recursive: true });

    this.state = failed ? 'failed' : 'closed';
  }
}
