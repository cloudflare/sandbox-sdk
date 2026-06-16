import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_SESSION_FRAME_PREFIX,
  createCommandSessionScript
} from './shell-script';

const FRAME_PREFIX = COMMAND_SESSION_FRAME_PREFIX;
const READY_TIMEOUT_MS = 2_000;

type SessionState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

type StdinWriter = {
  write(data: string): number | Promise<number>;
  end?: () => number | Promise<number>;
};

export type CommandSessionExecOptions = {
  timeoutMs?: number;
};

export type CommandSessionExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type StdioChunk = {
  stream: 'stdout' | 'stderr';
  data: string;
  seq: number;
};

export type CommandSessionStartProcessOptions = {
  onOutput?: (chunk: StdioChunk) => void;
};

export type CommandSessionProcessResult = CommandSessionExecResult;

type PendingOperation =
  | {
      kind: 'exec';
      id: string;
      resolve: (result: CommandSessionExecResult) => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'startProcess';
      id: string;
      onOutput?: (chunk: StdioChunk) => void;
      resolve: (process: CommandSessionProcess) => void;
      reject: (error: Error) => void;
    };

type ProcessCompletion = {
  output: StdioChunk[];
  nextSeq: number;
  onOutput?: (chunk: StdioChunk) => void;
  resolve: (result: CommandSessionProcessResult) => void;
  reject: (error: Error) => void;
};

export class CommandSessionProcess {
  constructor(
    private readonly pid: number,
    private readonly completion: Promise<CommandSessionProcessResult>
  ) {}

  wait(): Promise<CommandSessionProcessResult> {
    return this.completion;
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    try {
      process.kill(this.pid, signal);
    } catch {}
  }
}

export class CommandSession implements AsyncDisposable {
  private readonly shell: Bun.Subprocess;
  private readonly stdin: StdinWriter;
  private readonly tempDir: string;
  private readonly ready = Promise.withResolvers<void>();
  private readonly processes = new Map<string, ProcessCompletion>();
  private state: SessionState = 'starting';
  private outputBuffer = '';
  private pending?: PendingOperation;
  private failure?: Error;
  private cleanupPromise?: Promise<void>;
  private operationQueue: Promise<void> = Promise.resolve();

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
    return this.enqueueOperation(() => this.execNow(command, options));
  }

  async startProcess(
    command: string,
    options: CommandSessionStartProcessOptions = {}
  ): Promise<CommandSessionProcess> {
    return this.enqueueOperation(() => this.startProcessNow(command, options));
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
    this.rejectProcesses(error);
    await this.cleanupResources();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private enqueueOperation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(run, run);
    this.operationQueue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  private async waitForReady(): Promise<void> {
    await Promise.race([
      this.ready.promise,
      Bun.sleep(READY_TIMEOUT_MS).then(() => {
        throw new Error('Timed out waiting for command session readiness');
      })
    ]);
  }

  private async execNow(
    command: string,
    options: CommandSessionExecOptions
  ): Promise<CommandSessionExecResult> {
    this.assertReadyForOperation();

    const id = crypto.randomUUID().replaceAll('-', '');
    const encodedCommand = Buffer.from(command).toString('base64');
    const result = new Promise<CommandSessionExecResult>((resolve, reject) => {
      const pending: PendingOperation = { kind: 'exec', id, resolve, reject };
      if (options.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          const error = new Error(`Timed out waiting for command ${id}`);
          this.fail(error);
          void this.cleanupResources();
        }, options.timeoutMs);
      }
      this.pending = pending;
    });

    await this.writeShell(`__sandbox_sessions_exec ${id} ${encodedCommand}\n`);
    return result;
  }

  private async startProcessNow(
    command: string,
    options: CommandSessionStartProcessOptions
  ): Promise<CommandSessionProcess> {
    this.assertReadyForOperation();

    const id = crypto.randomUUID().replaceAll('-', '');
    const encodedCommand = Buffer.from(command).toString('base64');
    const process = new Promise<CommandSessionProcess>((resolve, reject) => {
      this.pending = {
        kind: 'startProcess',
        id,
        onOutput: options.onOutput,
        resolve,
        reject
      };
    });

    await this.writeShell(
      `__sandbox_sessions_start_process ${id} ${encodedCommand}\n`
    );
    return process;
  }

  private assertReadyForOperation(): void {
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
      throw new Error('Command session already has a pending operation');
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

    const [, type, id, field, stdoutPayload = '', stderrPayload = ''] =
      line.split('|');
    if (type === 'READY') {
      if (this.state === 'starting') {
        this.state = 'ready';
        this.ready.resolve();
      }
      return;
    }

    if (type === 'PROCESS_OUTPUT') {
      this.recordProcessOutput(id, field, stdoutPayload);
      return;
    }

    if (type === 'PROCESS_DONE') {
      this.resolveProcess(id, field);
      return;
    }

    if (!this.pending || this.pending.id !== id) {
      return;
    }

    if (type === 'DONE' && this.pending.kind === 'exec') {
      const pending = this.pending;
      this.pending = undefined;
      this.cleanupPending(pending);
      pending.resolve(decodeResult(field, stdoutPayload, stderrPayload));
      return;
    }

    if (type === 'PROCESS_STARTED' && this.pending.kind === 'startProcess') {
      const pending = this.pending;
      this.pending = undefined;
      const completion = Promise.withResolvers<CommandSessionProcessResult>();
      this.processes.set(id, {
        output: [],
        nextSeq: 0,
        onOutput: pending.onOutput,
        resolve: completion.resolve,
        reject: completion.reject
      });
      pending.resolve(
        new CommandSessionProcess(parsePID(field), completion.promise)
      );
    }
  }

  private recordProcessOutput(
    id: string,
    stream: string,
    payload: string
  ): void {
    const process = this.processes.get(id);
    if (!process || (stream !== 'stdout' && stream !== 'stderr')) {
      return;
    }

    const data = decodePayload(payload);
    if (data.length === 0) {
      return;
    }

    const chunk: StdioChunk = {
      stream,
      data,
      seq: process.nextSeq++
    };
    process.output.push(chunk);
    try {
      process.onOutput?.(chunk);
    } catch (error) {
      process.reject(toError(error));
      this.processes.delete(id);
    }
  }

  private resolveProcess(id: string, exitCode: string): void {
    const process = this.processes.get(id);
    if (!process) {
      return;
    }
    this.processes.delete(id);
    const parsedExitCode = Number.parseInt(exitCode, 10);
    process.resolve({
      exitCode: Number.isNaN(parsedExitCode) ? 1 : parsedExitCode,
      stdout: collectProcessOutput(process.output, 'stdout'),
      stderr: collectProcessOutput(process.output, 'stderr')
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.state !== 'closing' && this.state !== 'closed') {
      this.state = 'failed';
    }
    this.ready.reject(error);
    this.rejectPending(error);
    this.rejectProcesses(error);
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private rejectProcesses(error: Error): void {
    for (const process of this.processes.values()) {
      process.reject(error);
    }
    this.processes.clear();
  }

  private cleanupPending(pending: PendingOperation): void {
    if (pending.kind === 'exec' && pending.timeout) {
      clearTimeout(pending.timeout);
    }
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

function decodeResult(
  exitCode: string,
  stdoutPayload: string,
  stderrPayload: string
): CommandSessionExecResult {
  const parsedExitCode = Number.parseInt(exitCode, 10);
  return {
    exitCode: Number.isNaN(parsedExitCode) ? 1 : parsedExitCode,
    stdout: decodePayload(stdoutPayload),
    stderr: decodePayload(stderrPayload)
  };
}

function collectProcessOutput(
  output: StdioChunk[],
  stream: StdioChunk['stream']
): string {
  return output
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join('');
}

function decodePayload(payload: string): string {
  return Buffer.from(payload, 'base64').toString();
}

function parsePID(pid: string): number {
  const parsedPID = Number.parseInt(pid, 10);
  if (!Number.isInteger(parsedPID) || parsedPID <= 0) {
    throw new Error(`Invalid process PID ${pid}`);
  }
  return parsedPID;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getShellStdin(shell: Bun.Subprocess): StdinWriter {
  const stdin = shell.stdin;
  if (!stdin || typeof stdin === 'number' || !('write' in stdin)) {
    throw new Error('Command session shell stdin is not writable');
  }
  return stdin;
}
