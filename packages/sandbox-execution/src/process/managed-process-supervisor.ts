import type { ExecutionArgv } from '../command';
import type { RuntimeManagedProcess } from './managed-process';
import { ProcessLogStore } from './process-log-store';
import { isProcessGroupRunning, signalProcessTree } from './process-tree';
import { observedSignalNumber, validateSignal } from './signals';
import {
  type DrainCancellation,
  DrainCancellationSource,
  drainReadableStream
} from './stream-drain';
import type {
  RuntimeProcessExit,
  RuntimeProcessFailure,
  RuntimeProcessState,
  RuntimeProcessStatus
} from './types';

export interface RuntimeProcessLaunchOptions {
  runId: string;
  command: ExecutionArgv;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onTerminal?: (snapshot: RuntimeProcessStatus) => void | Promise<void>;
}

interface ExitWaiter {
  resolve(snapshot: RuntimeProcessStatus): void;
}

const DEFAULT_GRACE_MS = 1_000;
const SIGNAL_FAILURE_SETTLE_MS = 100;
const PROCESS_GROUP_POLL_MS = 25;

type Drain = (
  stream: ReadableStream<Uint8Array>,
  append: (data: Uint8Array) => void,
  cancellation: DrainCancellation
) => Promise<void>;
type SignalTree = (
  pid: number,
  signal: number,
  exited: Promise<number>
) => Promise<void>;
type ExitSettled = () => void;
type GroupRunning = (pid: number) => boolean;
interface ProcessDependencies {
  signalTree: SignalTree;
  drainStream: Drain;
  exitSettled: ExitSettled;
  groupRunning: GroupRunning;
}

let testSignalTree: SignalTree = signalProcessTree;
let testDrainStream: Drain = drainReadableStream;
let testExitSettled: ExitSettled = () => {};
let testGroupRunning: GroupRunning = isProcessGroupRunning;

export function setManagedProcessSupervisorTestHooks(hooks?: {
  signal?: SignalTree;
  drain?: Drain;
  exitSettled?: ExitSettled;
  groupRunning?: GroupRunning;
}): void {
  testSignalTree = hooks?.signal ?? signalProcessTree;
  testDrainStream = hooks?.drain ?? drainReadableStream;
  testExitSettled = hooks?.exitSettled ?? (() => {});
  testGroupRunning = hooks?.groupRunning ?? isProcessGroupRunning;
}

class RuntimeManagedProcessImpl implements RuntimeManagedProcess {
  readonly pid: number;
  readonly #runId: string;
  readonly #command: ExecutionArgv;
  readonly #cwd?: string;
  readonly #startedAt = new Date().toISOString();
  readonly #logStore: ProcessLogStore;
  readonly #subprocess: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly #onTerminal?: RuntimeProcessLaunchOptions['onTerminal'];
  readonly #dependencies: ProcessDependencies;
  readonly #exitWaiters = new Set<ExitWaiter>();
  readonly #drainCancellation = new DrainCancellationSource();
  #state: RuntimeProcessState = 'running';
  #exit?: RuntimeProcessExit;
  #error?: RuntimeProcessFailure;
  #signalFailure?: RuntimeProcessFailure;
  #endedAt?: string;
  #timeout?: ReturnType<typeof setTimeout>;
  #killFallback?: ReturnType<typeof setTimeout>;
  #timeoutRequested = false;
  #teardownControl?: Promise<void>;
  #exitSettled = false;
  #callback = Promise.resolve();
  #signalFailureResolve?: (failure: RuntimeProcessFailure) => void;
  #groupPollWake?: () => void;
  #groupMonitoringStopped = false;
  readonly #signalFailureObserved = new Promise<RuntimeProcessFailure>(
    (resolve) => {
      this.#signalFailureResolve = resolve;
    }
  );

  constructor(
    options: RuntimeProcessLaunchOptions,
    subprocess: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    dependencies: ProcessDependencies
  ) {
    if (!Number.isSafeInteger(subprocess.pid) || subprocess.pid <= 0) {
      throw new Error('Subprocess PID must be available after spawn');
    }
    this.pid = subprocess.pid;
    this.#runId = options.runId;
    this.#command = Object.freeze([...options.command]) as ExecutionArgv;
    this.#cwd = options.cwd;
    this.#logStore = new ProcessLogStore(options.runId);
    this.#subprocess = subprocess;
    this.#onTerminal = options.onTerminal;
    this.#dependencies = dependencies;
    if (options.timeoutMs !== undefined) {
      this.#timeout = setTimeout(() => {
        this.#timeoutRequested = true;
        void this.stopForTeardown(DEFAULT_GRACE_MS).catch((error) =>
          this.#recordSignalFailure(
            processFailure(
              'SIGNAL_FAILED',
              error instanceof Error ? error.message : 'Unknown process error'
            ),
            true
          )
        );
      }, options.timeoutMs);
    }
    void this.#monitor();
  }

  snapshot(): RuntimeProcessStatus {
    const base = {
      pid: this.pid,
      command: this.#command,
      cwd: this.#cwd,
      startedAt: this.#startedAt
    };
    if (this.#state === 'running') {
      return { ...base, state: 'running' };
    }
    const endedAt = this.#endedAt ?? new Date().toISOString();
    if (this.#state === 'exited' && this.#exit) {
      return { ...base, state: 'exited', exit: { ...this.#exit }, endedAt };
    }
    return {
      ...base,
      state: 'error',
      error: { ...(this.#error ?? unknownFailure()) },
      endedAt
    };
  }

  logs(options?: Parameters<ProcessLogStore['subscribe']>[0]) {
    return this.#logStore.subscribe(options);
  }

  waitForExit(): Promise<RuntimeProcessStatus> {
    if (this.#state !== 'running') return Promise.resolve(this.snapshot());
    return new Promise((resolve) => this.#exitWaiters.add({ resolve }));
  }

  async kill(signal = 15): Promise<void> {
    const validatedSignal = validateSignal(signal);
    if (this.#state !== 'running') return;
    await this.#deliverSignal(validatedSignal, {
      rejectOnFailure: true,
      forceCleanupOnFailure: false
    });
  }

  async stopForTeardown(graceMs = DEFAULT_GRACE_MS): Promise<void> {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error('graceMs must be a non-negative number');
    }
    if (this.#state !== 'running') return;
    if (this.#teardownControl) return this.#teardownControl;
    this.#teardownControl = this.#stopForTeardown(graceMs);
    return this.#teardownControl;
  }

  async #stopForTeardown(graceMs: number): Promise<void> {
    await this.#deliverSignal(15, {
      rejectOnFailure: false,
      forceCleanupOnFailure: true
    });
    if (this.#state !== 'running') return;
    this.#killFallback = setTimeout(() => {
      if (this.#state !== 'running') return;
      void this.#deliverSignal(9, {
        rejectOnFailure: false,
        forceCleanupOnFailure: true
      });
    }, graceMs);
  }

  async #deliverSignal(
    signal: number,
    options: { rejectOnFailure: boolean; forceCleanupOnFailure: boolean }
  ): Promise<void> {
    try {
      await this.#dependencies.signalTree(
        this.pid,
        signal,
        this.#subprocess.exited
      );
      this.#wakeGroupMonitor();
    } catch (error) {
      if (this.#state !== 'running') return;
      const failure = processFailure(
        'SIGNAL_FAILED',
        error instanceof Error ? error.message : 'Unknown process error'
      );
      if (options.forceCleanupOnFailure) {
        this.#recordSignalFailure(failure, true);
      }
      if (options.rejectOnFailure) throw new Error(failure.message);
    }
  }

  #recordSignalFailure(
    failure: RuntimeProcessFailure,
    forceCleanup: boolean
  ): void {
    if (this.#state !== 'running') return;
    this.#signalFailure = failure;
    this.#signalFailureResolve?.(failure);
    this.#signalFailureResolve = undefined;
    if (forceCleanup) this.#forceKillAfterFailure();
  }

  #forceKillAfterFailure(): void {
    try {
      process.kill(-this.pid, 9);
    } catch {
      try {
        this.#subprocess.kill(9);
      } catch {
        // Best-effort cleanup after a supervision failure.
      }
    }
  }

  async #monitor(): Promise<void> {
    const stdout = invokeDrain(
      this.#dependencies.drainStream,
      this.#subprocess.stdout,
      (data) => this.#logStore.appendOutput('stdout', data),
      this.#drainCancellation
    );
    const stderr = invokeDrain(
      this.#dependencies.drainStream,
      this.#subprocess.stderr,
      (data) => this.#logStore.appendOutput('stderr', data),
      this.#drainCancellation
    );
    let drainFailureResolve: (() => void) | undefined;
    let firstDrainFailure: RuntimeProcessFailure | undefined;
    const drainFailure = new Promise<void>((resolve) => {
      drainFailureResolve = resolve;
    });
    const observeDrain = (pending: Promise<void>): Promise<void> =>
      pending.catch((reason) => {
        if (!firstDrainFailure) {
          firstDrainFailure = processFailure(
            'DRAIN_FAILED',
            reason instanceof Error ? reason.message : 'Unknown process error'
          );
          if (this.#state === 'running') this.#forceKillAfterFailure();
          this.#drainCancellation.abort();
          drainFailureResolve?.();
          drainFailureResolve = undefined;
        }
        throw reason;
      });
    const settledDrains = Promise.allSettled([
      observeDrain(stdout),
      observeDrain(stderr)
    ]);
    const processGroupGone = this.#monitorProcessGroup();
    const exit = this.#subprocess.exited.then((code) => {
      this.#exitSettled = true;
      this.#dependencies.exitSettled();
      this.#wakeGroupMonitor();
      return code;
    });
    const first: number | RuntimeProcessFailure = await Promise.race([
      exit.catch((error) =>
        processFailure(
          'EXIT_FAILED',
          error instanceof Error ? error.message : 'Unknown process error'
        )
      ),
      this.#signalFailureObserved.then(async (failure) => {
        await Promise.race([Bun.sleep(SIGNAL_FAILURE_SETTLE_MS), drainFailure]);
        this.#drainCancellation.abort();
        return failure;
      }),
      processGroupGone.then(
        async (failure): Promise<number | RuntimeProcessFailure> => {
          if (failure) return failure;
          return exit;
        }
      )
    ]);
    await settledDrains;
    // Output or supervision failures outrank an observed leader exit because
    // otherwise the record could report success after losing lifecycle truth.
    if (firstDrainFailure) {
      await processGroupGone;
      this.#transitionError(firstDrainFailure);
      return;
    }
    if (this.#signalFailure) {
      this.#transitionError(this.#signalFailure);
      return;
    }
    if (isFailure(first)) {
      this.#transitionError(first);
      return;
    }
    const groupFailure = await processGroupGone;
    if (groupFailure) {
      this.#transitionError(groupFailure);
      return;
    }
    try {
      this.#transitionExited(this.#observedExit(first));
    } catch (error) {
      this.#transitionError(
        processFailure(
          'EXIT_FAILED',
          error instanceof Error ? error.message : 'Unknown process error'
        )
      );
    }
  }

  async #monitorProcessGroup(): Promise<RuntimeProcessFailure | undefined> {
    while (!this.#groupMonitoringStopped) {
      try {
        if (!this.#dependencies.groupRunning(this.pid)) return;
      } catch (error) {
        const failure = processFailure(
          'PROCESS_GROUP_CHECK_FAILED',
          error instanceof Error ? error.message : 'Unknown process error'
        );
        this.#forceKillAfterFailure();
        this.#drainCancellation.abort();
        return failure;
      }
      await this.#waitForGroupPoll();
    }
  }

  #waitForGroupPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#groupPollWake = undefined;
        resolve();
      }, PROCESS_GROUP_POLL_MS);
      this.#groupPollWake = () => {
        clearTimeout(timeout);
        this.#groupPollWake = undefined;
        resolve();
      };
    });
  }

  #wakeGroupMonitor(): void {
    this.#groupPollWake?.();
  }

  #observedExit(code: number): RuntimeProcessExit {
    if (!Number.isInteger(code)) {
      throw new Error('Process exit code was not reported');
    }
    const signal = observedSignalNumber(this.#subprocess.signalCode);
    return {
      code,
      ...(signal !== undefined && { signal }),
      timedOut: this.#timeoutRequested
    };
  }

  #transitionExited(exit: RuntimeProcessExit): void {
    if (this.#state !== 'running') return;
    this.#state = 'exited';
    this.#exit = { ...exit };
    this.#finishTerminal();
    this.#logStore.appendTerminal({ state: 'exited', exit });
    this.#notifyTerminal();
  }

  #transitionError(error: RuntimeProcessFailure): void {
    if (this.#state !== 'running') return;
    this.#state = 'error';
    this.#error = { ...error };
    this.#finishTerminal();
    this.#logStore.appendTerminal({ state: 'error', error });
    this.#notifyTerminal();
  }

  #finishTerminal(): void {
    this.#groupMonitoringStopped = true;
    this.#wakeGroupMonitor();
    this.#endedAt = new Date().toISOString();
    if (this.#timeout) clearTimeout(this.#timeout);
    if (this.#killFallback) clearTimeout(this.#killFallback);
    this.#killFallback = undefined;
  }

  #notifyTerminal(): void {
    const snapshot = this.snapshot();
    for (const waiter of this.#exitWaiters) waiter.resolve(snapshot);
    this.#exitWaiters.clear();
    if (this.#onTerminal) {
      try {
        this.#callback = Promise.resolve(this.#onTerminal(snapshot)).catch(
          () => undefined
        );
      } catch {
        this.#callback = Promise.resolve();
      }
    }
  }

  waitForCallback(): Promise<void> {
    return this.#callback;
  }

  matchesTerminal(runId: string): boolean {
    return this.#runId === runId && this.#state !== 'running';
  }
}

export class ManagedProcessSupervisor implements AsyncDisposable {
  readonly #processes = new Map<string, RuntimeManagedProcessImpl>();
  #closed = false;

  async start(
    options: RuntimeProcessLaunchOptions
  ): Promise<RuntimeManagedProcess> {
    if (this.#closed) throw new Error('Process supervisor is closed');
    if (options.runId.length === 0) throw new Error('Run ID must not be empty');
    if (this.#processes.has(options.runId)) {
      throw new Error(`Run ID already exists: ${options.runId}`);
    }
    if (options.command.length === 0) {
      throw new Error('Command must not be empty');
    }
    if (options.command[0].length === 0) {
      throw new Error('Command executable must not be empty');
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new Error('timeoutMs must be a positive number');
    }
    const subprocess = Bun.spawn([...options.command], {
      cwd: options.cwd,
      env: buildEnvironment(options.env),
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const managed = new RuntimeManagedProcessImpl(options, subprocess, {
      signalTree: testSignalTree,
      drainStream: testDrainStream,
      exitSettled: testExitSettled,
      groupRunning: testGroupRunning
    });
    this.#processes.set(options.runId, managed);
    return managed;
  }

  get(runId: string): RuntimeManagedProcess | undefined {
    return this.#processes.get(runId);
  }

  list(): RuntimeProcessStatus[] {
    return [...this.#processes.values()].map((process) => process.snapshot());
  }

  removeTerminal(runId: string): boolean {
    const process = this.#processes.get(runId);
    if (!process?.matchesTerminal(runId)) return false;
    return this.#processes.delete(runId);
  }

  hasActive(): boolean {
    return [...this.#processes.values()].some(
      (process) => process.snapshot().state === 'running'
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const processes = [...this.#processes.values()];
    await Promise.all(processes.map((process) => process.stopForTeardown()));
    await Promise.all(processes.map((process) => process.waitForExit()));
    await Promise.all(processes.map((process) => process.waitForCallback()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function invokeDrain(
  drain: Drain,
  stream: ReadableStream<Uint8Array>,
  append: (data: Uint8Array) => void,
  cancellation: DrainCancellation
): Promise<void> {
  try {
    return Promise.resolve(drain(stream, append, cancellation));
  } catch (error) {
    return Promise.reject(error);
  }
}

function buildEnvironment(
  overrides: Record<string, string> | undefined
): Record<string, string> {
  // Execution intentionally inherits the complete container environment and
  // treats caller values as an overlay. This substrate does not curate the
  // environment because commands run within the sandbox's trust boundary.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    env[name] = value;
  }
  return env;
}

function processFailure(code: string, message: string): RuntimeProcessFailure {
  return { code, message };
}

function unknownFailure(): RuntimeProcessFailure {
  return processFailure('UNKNOWN', 'Unknown process error');
}

function isFailure(
  value: number | RuntimeProcessFailure
): value is RuntimeProcessFailure {
  return typeof value !== 'number';
}
