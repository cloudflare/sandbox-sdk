import type { Subprocess } from 'bun';
import { SequencedByteLog } from '../io/sequenced-byte-log';
import type { ExecutionLogger } from '../logger';
import type {
  RuntimeProcessExit,
  RuntimeProcessFailure
} from '../process/managed-process';
import type { ProcessLogSubscriptionOptions } from '../process/process-log-store';
import {
  getDescendantPids,
  isPidRunning,
  isProcessGroupRunning,
  signalProcessTree
} from '../process/process-tree';
import { observedSignalNumber } from '../process/signals';
import type {
  PtyProcessOptions,
  RuntimeTerminalOutputEvent,
  RuntimeTerminalResult,
  RuntimeTerminalSnapshot
} from './types';

const DEFAULT_BUFFER_SIZE = 256 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_TERMINATE_GRACE_MS = 500;

type Terminal = InstanceType<typeof Bun.Terminal>;

type PtyCompletionState = {
  subprocessResult: RuntimeTerminalResult | undefined;
  terminalEOF: boolean;
  finished: boolean;
};

export class PtyCompletionBarrier {
  readonly #state: PtyCompletionState = {
    subprocessResult: undefined,
    terminalEOF: false,
    finished: false
  };
  readonly #finish: (result: RuntimeTerminalResult) => void;

  constructor(finish: (result: RuntimeTerminalResult) => void) {
    this.#finish = finish;
  }

  subprocessExited(code: number, signalCode: NodeJS.Signals | null): void {
    try {
      this.#state.subprocessResult = {
        state: 'exited',
        exit: observedExit(code, signalCode, false)
      };
    } catch (error) {
      this.subprocessExitFailed(error instanceof Error ? error : undefined);
      return;
    }
    this.#tryFinish();
  }

  subprocessExitFailed(error?: Error): void {
    this.#state.subprocessResult = {
      state: 'error',
      error: ptyFailure(
        'PTY_EXIT_FAILED',
        error?.message ?? 'Unknown PTY error'
      )
    };
    this.#tryFinish();
  }

  terminalEOF(): void {
    this.#state.terminalEOF = true;
    this.#tryFinish();
  }

  #tryFinish(): void {
    // Natural completion intentionally requires Bun's terminal EOF after the
    // root subprocess outcome. A timeout fallback could discard buffered PTY
    // bytes, so a missing EOF keeps the wait pending until explicit close.
    if (
      this.#state.finished ||
      !this.#state.terminalEOF ||
      !this.#state.subprocessResult
    ) {
      return;
    }
    this.#state.finished = true;
    this.#finish(this.#state.subprocessResult);
  }
}

export class PtyProcess implements AsyncDisposable {
  readonly #terminal: Terminal;
  readonly #process: Subprocess;
  readonly #log: SequencedByteLog<'data', RuntimeTerminalResult>;
  readonly #logger?: ExecutionLogger;
  #result: RuntimeTerminalResult | undefined;
  #exitPromise: Promise<RuntimeTerminalResult>;
  #resolveExit: (result: RuntimeTerminalResult) => void = () => {};
  #terminateControl?: Promise<void>;

  private constructor(options: {
    terminal: Terminal;
    process: Subprocess;
    log: SequencedByteLog<'data', RuntimeTerminalResult>;
    logger?: ExecutionLogger;
  }) {
    this.#terminal = options.terminal;
    this.#process = options.process;
    this.#log = options.log;
    this.#logger = options.logger;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  static async create(options: PtyProcessOptions): Promise<PtyProcess> {
    if (options.command.length === 0) {
      throw new Error('Command must not be empty');
    }
    if (options.command[0].length === 0) {
      throw new Error('Command executable must not be empty');
    }

    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    validateDimensions(cols, rows);

    const log = new SequencedByteLog<'data', RuntimeTerminalResult>({
      storeId: crypto.randomUUID(),
      maxBytes: options.bufferSize ?? DEFAULT_BUFFER_SIZE,
      maxEvents: DEFAULT_MAX_EVENTS,
      copyTerminal: copyTerminalResult
    });
    let pty: PtyProcess | undefined;
    const completion = new PtyCompletionBarrier((exit) => pty?.finish(exit));
    const spawned = Bun.spawn([...options.command], {
      terminal: {
        cols,
        rows,
        name: 'xterm-256color',
        data: (_terminal, data: Uint8Array) => {
          log.append('data', data);
        },
        exit: () => {
          completion.terminalEOF();
        }
      },
      cwd: options.cwd,
      // PTYs inherit the complete container environment. Caller values are an
      // overlay, while TERM remains owned by the terminal substrate.
      env: { ...process.env, ...options.env, TERM: 'xterm-256color' }
    });
    const terminal = spawned.terminal;
    if (!terminal) {
      spawned.kill(9);
      throw new Error('PTY terminal was not created');
    }
    pty = new PtyProcess({
      terminal,
      process: spawned,
      log,
      logger: options.logger
    });
    spawned.exited
      .then((code) => {
        completion.subprocessExited(code, spawned.signalCode);
      })
      .catch((error) => {
        const exitError =
          error instanceof Error ? error : new Error('Unknown PTY error');
        options.logger?.error('PTY process exit wait failed', exitError);
        completion.subprocessExitFailed(exitError);
      });
    return pty;
  }

  snapshot(): RuntimeTerminalSnapshot {
    if (!this.#result) return { pid: this.#process.pid, state: 'running' };
    if (this.#result.state === 'exited') {
      return {
        pid: this.#process.pid,
        state: 'exited',
        exit: { ...this.#result.exit }
      };
    }
    return {
      pid: this.#process.pid,
      state: 'error',
      error: { ...this.#result.error }
    };
  }

  output(
    options?: ProcessLogSubscriptionOptions
  ): ReadableStream<RuntimeTerminalOutputEvent> {
    return this.#log.subscribe(options).pipeThrough(
      new TransformStream({
        transform(event, controller) {
          if (event.type === 'terminal') {
            controller.enqueue({
              type: 'terminal',
              cursor: event.cursor,
              timestamp: event.timestamp,
              ...copyTerminalResult(event.value)
            });
            return;
          }
          controller.enqueue(event);
        }
      })
    );
  }

  async write(data: Uint8Array): Promise<void> {
    this.#ensureRunning();
    this.#terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.#ensureRunning();
    validateDimensions(cols, rows);
    this.#terminal.resize(cols, rows);
  }

  async waitForExit(): Promise<RuntimeTerminalResult> {
    return copyTerminalResult(await this.#exitPromise);
  }

  async interrupt(): Promise<void> {
    if (this.#result) return;
    await signalProcessTree(this.#process.pid, 2);
  }

  async terminate(): Promise<void> {
    if (this.#result) return;
    if (this.#terminateControl) return this.#terminateControl;
    this.#terminateControl = this.#terminateTree();
    return this.#terminateControl;
  }

  async close(): Promise<void> {
    if (!this.#result) await this.terminate();
    try {
      if (!this.#terminal.closed) this.#terminal.close();
    } catch (error) {
      this.#logger?.debug('PTY terminal close failed', { error });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private finish(result: RuntimeTerminalResult): void {
    if (this.#result) return;
    this.#result = copyTerminalResult(result);
    this.#log.close(this.#result);
    this.#resolveExit(this.#result);
    if (this.#result.state === 'exited') {
      this.#logger?.info('PTY process exited', {
        code: this.#result.exit.code,
        signal: this.#result.exit.signal,
        timedOut: this.#result.exit.timedOut
      });
      return;
    }
    this.#logger?.error(
      'PTY process failed',
      new Error(this.#result.error.message)
    );
  }

  async #terminateTree(): Promise<void> {
    const descendants = await getDescendantPids(this.#process.pid);
    await signalProcessTree(this.#process.pid, 15);
    if (
      !(await this.#waitForTreeExitWithin(
        descendants,
        DEFAULT_TERMINATE_GRACE_MS
      ))
    ) {
      await signalProcessTree(this.#process.pid, 9);
      signalPids(descendants, 9);
      await this.#waitForTreeExitWithin(
        descendants,
        DEFAULT_TERMINATE_GRACE_MS
      );
    }
    await this.waitForExit();
  }

  async #waitForTreeExitWithin(
    descendants: number[],
    ms: number
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (
        this.#result &&
        !isProcessGroupRunning(this.#process.pid) &&
        !anyPidRunning(descendants)
      ) {
        return true;
      }
      await Bun.sleep(25);
    }
    return (
      this.#result !== undefined &&
      !isProcessGroupRunning(this.#process.pid) &&
      !anyPidRunning(descendants)
    );
  }

  #ensureRunning(): void {
    if (this.#result) throw new Error('PTY is closed');
  }
}

function observedExit(
  code: number,
  signalCode: NodeJS.Signals | null,
  timedOut: boolean
): RuntimeProcessExit {
  if (!Number.isInteger(code)) {
    throw new Error('PTY process exit code was not reported');
  }
  const signal = observedSignalNumber(signalCode);
  return {
    code,
    ...(signal !== undefined && { signal }),
    timedOut
  };
}

function ptyFailure(code: string, message: string): RuntimeProcessFailure {
  return { code, message };
}

function copyTerminalResult(
  result: RuntimeTerminalResult
): RuntimeTerminalResult {
  if (result.state === 'exited') {
    return { state: 'exited', exit: { ...result.exit } };
  }
  return { state: 'error', error: { ...result.error } };
}

function anyPidRunning(pids: number[]): boolean {
  return pids.some((pid) => isPidRunning(pid));
}

function signalPids(pids: number[], signal: number): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function validateDimensions(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols <= 0 ||
    rows <= 0
  )
    throw new Error('Invalid dimensions');
}
