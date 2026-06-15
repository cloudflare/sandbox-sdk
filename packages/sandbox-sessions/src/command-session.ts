import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_SESSION_FRAME_PREFIX,
  createCommandSessionScript
} from './shell-script';

const FRAME_PREFIX = COMMAND_SESSION_FRAME_PREFIX;
const DEFAULT_TIMEOUT_MS = 2_000;

type SessionState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

type StdinWriter = {
  write(data: string): number | Promise<number>;
  end?: () => number | Promise<number>;
};

export type StdioChunk = {
  stream: 'stdout' | 'stderr';
  data: string;
  seq: number;
};

export type CommandSessionExecOptions = {
  timeoutMs?: number;
  onOutput?: (chunk: StdioChunk) => void;
};

export type CommandSessionExecResult = {
  exitCode: number;
  output: StdioChunk[];
};

type PendingCommand = {
  id: string;
  output: StdioChunk[];
  nextSeq: number;
  onOutput?: (chunk: StdioChunk) => void;
  resolve: (result: CommandSessionExecResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class CommandSession implements AsyncDisposable {
  private readonly shell: Bun.Subprocess;
  private readonly stdin: StdinWriter;
  private readonly tempDir: string;
  private readonly ready = Promise.withResolvers<void>();
  private state: SessionState = 'starting';
  private outputBuffer = '';
  private pending?: PendingCommand;
  private failure?: Error;
  private cleanupPromise?: Promise<void>;
  private operationQueue: Promise<CommandSessionExecResult> = Promise.resolve({
    exitCode: 0,
    output: []
  });

  private constructor(options: {
    shell: Bun.Subprocess;
    stdin: StdinWriter;
    tempDir: string;
  }) {
    this.shell = options.shell;
    this.stdin = options.stdin;
    this.tempDir = options.tempDir;
    this.ready.promise.catch(() => {});
    this.shell.exited.then((exitCode) => {
      if (
        this.state !== 'closing' &&
        this.state !== 'closed' &&
        this.state !== 'failed'
      ) {
        this.fail(
          new Error(`Command session shell exited with code ${exitCode}`)
        );
      }
    });
    void this.readFrames();
  }

  static async create(
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<CommandSession> {
    const tempDir = await mkdtemp(join(tmpdir(), 'sandbox-command-session-'));
    const shell = Bun.spawn(['bash', '--noprofile', '--norc'], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        HISTFILE: ''
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    });

    const session = new CommandSession({
      shell,
      stdin: getShellStdin(shell),
      tempDir
    });

    try {
      await session.writeShell(createCommandSessionScript(tempDir));
      await session.waitForReady();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async exec(
    command: string,
    options: CommandSessionExecOptions = {}
  ): Promise<CommandSessionExecResult> {
    const run = async (): Promise<CommandSessionExecResult> =>
      this.execNow(command, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onOutput: options.onOutput
      });
    const result = this.operationQueue.then(run, run);
    this.operationQueue = result.catch(() => ({ exitCode: 1, output: [] }));
    return result;
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }

    const error = this.failure ?? new Error('Command session is closed');
    this.failure = error;
    if (this.state !== 'failed') {
      this.state = 'closing';
    }
    this.ready.reject(error);
    this.rejectPending(error);
    await this.cleanupResources();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async waitForReady(): Promise<void> {
    await Promise.race([
      this.ready.promise,
      Bun.sleep(DEFAULT_TIMEOUT_MS).then(() => {
        throw new Error('Timed out waiting for command session readiness');
      })
    ]);
  }

  private async execNow(
    command: string,
    options: Required<Pick<CommandSessionExecOptions, 'timeoutMs'>> &
      Pick<CommandSessionExecOptions, 'onOutput'>
  ): Promise<CommandSessionExecResult> {
    this.assertReadyForExec();

    const id = crypto.randomUUID().replaceAll('-', '');
    const encodedCommand = Buffer.from(command).toString('base64');
    const result = new Promise<CommandSessionExecResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Timed out waiting for command ${id}`);
        this.fail(error);
        void this.cleanupResources();
      }, options.timeoutMs);
      this.pending = {
        id,
        output: [],
        nextSeq: 0,
        onOutput: options.onOutput,
        resolve,
        reject,
        timeout
      };
    });

    await this.writeShell(`__sandbox_sessions_exec ${id} ${encodedCommand}\n`);
    return result;
  }

  private assertReadyForExec(): void {
    if (this.state === 'closed' || this.state === 'closing') {
      throw new Error('Command session is closed');
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.state !== 'ready') {
      throw new Error(`Command session is ${this.state}`);
    }
    if (this.pending) {
      throw new Error('Command session already has a pending command');
    }
  }

  private async writeShell(data: string): Promise<void> {
    await this.stdin.write(data);
  }

  private async readFrames(): Promise<void> {
    const stdout = this.shell.stdout;
    if (!stdout || typeof stdout === 'number') {
      this.fail(new Error('Command session shell stdout is not available'));
      return;
    }

    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        this.outputBuffer += decoder.decode(value, { stream: true });
        this.processFrameLines();
      }
      this.outputBuffer += decoder.decode();
      this.processFrameLines();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(new Error(`Command session frame reader failed: ${message}`));
    } finally {
      reader.releaseLock();
    }
  }

  private processFrameLines(): void {
    while (true) {
      const newlineIndex = this.outputBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = this.outputBuffer.slice(0, newlineIndex);
      this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
      this.handleFrameLine(line);
    }
  }

  private handleFrameLine(line: string): void {
    if (!line.startsWith(`${FRAME_PREFIX}|`)) {
      return;
    }

    const [, type, id, streamOrExitCode, payload = ''] = line.split('|');
    if (type === 'READY') {
      if (this.state === 'starting') {
        this.state = 'ready';
        this.ready.resolve();
      }
      return;
    }

    if (!this.pending || this.pending.id !== id) {
      return;
    }

    if (type === 'OUTPUT') {
      this.recordOutput(streamOrExitCode, payload);
      return;
    }

    if (type === 'DONE') {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timeout);
      const parsedExitCode = Number.parseInt(streamOrExitCode, 10);
      pending.resolve({
        exitCode: Number.isNaN(parsedExitCode) ? 1 : parsedExitCode,
        output: pending.output
      });
    }
  }

  private recordOutput(stream: string, payload: string): void {
    if (!this.pending || (stream !== 'stdout' && stream !== 'stderr')) {
      return;
    }

    const data = Buffer.from(payload, 'base64').toString();
    if (data.length === 0) {
      return;
    }

    const chunk: StdioChunk = {
      stream,
      data,
      seq: this.pending.nextSeq++
    };
    this.pending.output.push(chunk);
    this.pending.onOutput?.(chunk);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.state !== 'closing' && this.state !== 'closed') {
      this.state = 'failed';
    }
    this.ready.reject(error);
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    clearTimeout(this.pending.timeout);
    this.pending.reject(error);
    this.pending = undefined;
  }

  private cleanupResources(): Promise<void> {
    this.cleanupPromise ??= this.cleanupResourcesOnce();
    return this.cleanupPromise;
  }

  private async cleanupResourcesOnce(): Promise<void> {
    try {
      await this.stdin.write('exit\n');
    } catch {}
    try {
      this.stdin.end?.();
    } catch {}
    try {
      this.shell.kill('SIGTERM');
    } catch {}
    await Promise.race([this.shell.exited, Bun.sleep(500)]);
    await rm(this.tempDir, { force: true, recursive: true });
    this.state = this.failure ? 'failed' : 'closed';
  }
}

function getShellStdin(shell: Bun.Subprocess): StdinWriter {
  const stdin = shell.stdin;
  if (!stdin || typeof stdin === 'number' || !('write' in stdin)) {
    throw new Error('Command session shell stdin is not writable');
  }
  return stdin;
}
