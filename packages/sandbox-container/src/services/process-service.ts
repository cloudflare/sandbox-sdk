import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import {
  ManagedProcessSupervisor,
  type RuntimeManagedProcess,
  type RuntimeProcessLogEvent,
  type RuntimeProcessStatus
} from '@repo/sandbox-execution';
import {
  ErrorCode,
  type Logger,
  logCanonicalEvent,
  type ProcessLogEvent,
  type ProcessLogsRPCOptions,
  type ProcessStartOptions,
  type ProcessStatus,
  type SandboxCommand
} from '@repo/shared';

export const MAX_RETAINED_TERMINAL_PROCESSES = 64;

interface ProcessSupervisor {
  start(options: {
    runId: string;
    command: SandboxCommand;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    onTerminal?: (status: RuntimeProcessStatus) => void | Promise<void>;
  }): Promise<RuntimeManagedProcess>;
  get(runId: string): RuntimeManagedProcess | undefined;
  list(): RuntimeProcessStatus[];
  removeTerminal(runId: string): boolean;
  hasActive(): boolean;
  [Symbol.asyncDispose](): Promise<void>;
}

interface ProcessServiceOptions {
  supervisor?: ProcessSupervisor;
  logger: Logger;
}

interface ProcessServiceError extends Error {
  code: string;
  details?: Record<string, string | number | boolean | undefined>;
}

interface SystemError extends Error {
  code?: string;
  path?: string;
}

export class ProcessService {
  readonly #supervisor: ProcessSupervisor;
  readonly #logger: Logger;
  readonly #processes = new Map<string, RuntimeManagedProcess>();
  readonly #completed = new Set<string>();

  constructor(options: ProcessServiceOptions) {
    this.#supervisor = options.supervisor ?? new ManagedProcessSupervisor();
    this.#logger = options.logger.child({ service: 'process' });
  }

  async start(
    command: SandboxCommand,
    options: ProcessStartOptions = {}
  ): Promise<ProcessStatus> {
    validateCommand(command);
    await validateOptions(options);
    const id = crypto.randomUUID();
    try {
      const process = await this.#supervisor.start({
        runId: id,
        command,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeout,
        onTerminal: (status) => this.onTerminal(id, status)
      });
      this.#processes.set(id, process);
      await this.enforceTerminalRetention();
      return statusToPublic(id, process.snapshot());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to spawn process';
      if (options.cwd !== undefined && isCwdSpawnFailure(error, options.cwd)) {
        throw serviceError(ErrorCode.INVALID_PROCESS_CWD, message, {
          processId: id,
          cwd: options.cwd,
          reason: message
        });
      }
      throw serviceError(ErrorCode.PROCESS_SPAWN_FAILED, message, {
        processId: id,
        command: command.join(' '),
        cwd: options.cwd,
        stderr: message
      });
    }
  }

  async get(id: string): Promise<ProcessStatus | null> {
    const process = this.#supervisor.get(id) ?? this.#processes.get(id);
    if (!process) return null;
    this.#processes.set(id, process);
    return statusToPublic(id, process.snapshot());
  }

  async list(): Promise<ProcessStatus[]> {
    return [...this.#processes.entries()].map(([id, process]) =>
      statusToPublic(id, process.snapshot())
    );
  }

  async openLogs(
    id: string,
    options: ProcessLogsRPCOptions = {}
  ): Promise<ReadableStream<ProcessLogEvent>> {
    validateCursor(options.since, id);
    const process = this.#supervisor.get(id) ?? this.#processes.get(id);
    if (!process) {
      throw serviceError(ErrorCode.PROCESS_NOT_FOUND, 'Process not found', {
        processId: id
      });
    }
    this.#processes.set(id, process);
    let stream: ReadableStream<RuntimeProcessLogEvent>;
    try {
      stream = process.logs({
        after: options.since,
        replay: options.replay,
        follow: options.follow
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Process log cursor is invalid';
      throw serviceError(ErrorCode.INVALID_PROCESS_CURSOR, message, {
        processId: id,
        cursor: options.since,
        reason: message
      });
    }
    return stream.pipeThrough(
      new TransformStream<RuntimeProcessLogEvent, ProcessLogEvent>({
        transform(event, controller) {
          controller.enqueue(logEventToPublic(event));
        }
      })
    );
  }

  async kill(id: string, signal?: number): Promise<void> {
    const process = this.#supervisor.get(id) ?? this.#processes.get(id);
    if (!process) {
      throw serviceError(ErrorCode.PROCESS_NOT_FOUND, 'Process not found', {
        processId: id
      });
    }
    this.#processes.set(id, process);
    const status = process.snapshot();
    if (status.state === 'exited') return;
    if (status.state === 'error') {
      throw serviceError(ErrorCode.PROCESS_ERROR, status.error.message, {
        processId: id
      });
    }
    try {
      await process.kill(signal);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to kill process';
      throw serviceError(ErrorCode.PROCESS_ERROR, message, {
        processId: id
      });
    }
  }

  async hasActive(): Promise<boolean> {
    return this.#supervisor.hasActive();
  }

  async enforceTerminalRetention(): Promise<void> {
    const terminal = [...this.#processes.entries()]
      .map(([id, process]) => ({ id, status: process.snapshot() }))
      .filter(({ status }) => status.state !== 'running')
      .sort((left, right) =>
        terminalTime(left.status).localeCompare(terminalTime(right.status))
      );
    for (const { id } of terminal.slice(
      0,
      Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_PROCESSES)
    )) {
      if (this.#supervisor.removeTerminal(id)) {
        this.#processes.delete(id);
        this.#completed.delete(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.#logger.debug('Shutting down process service');
    await this.#supervisor[Symbol.asyncDispose]();
  }

  async onTerminal(id: string, status: RuntimeProcessStatus): Promise<void> {
    if (this.#completed.has(id)) return;
    this.#completed.add(id);
    await this.enforceTerminalRetention();
    const publicStatus = statusToPublic(id, status);
    const durationMs = durationBetween(
      status.startedAt,
      status.state === 'running' ? undefined : status.endedAt
    );
    logCanonicalEvent(this.#logger, {
      event: 'process.complete',
      outcome: publicStatus.state === 'error' ? 'error' : 'success',
      processId: publicStatus.id,
      pid: publicStatus.pid,
      durationMs,
      processOutcome:
        publicStatus.state === 'error'
          ? 'supervisor_error'
          : publicStatus.state === 'exited' &&
              publicStatus.exit.signal !== undefined
            ? 'signal'
            : 'exit',
      exitCode:
        publicStatus.state === 'exited' ? publicStatus.exit.code : undefined,
      signal:
        publicStatus.state === 'exited' ? publicStatus.exit.signal : undefined,
      timedOut:
        publicStatus.state === 'exited'
          ? publicStatus.exit.timedOut
          : undefined,
      failureCode:
        publicStatus.state === 'error' ? publicStatus.error.code : undefined
    });
  }
}

function validateCommand(command: SandboxCommand): void {
  if (!Array.isArray(command) || command.length === 0) {
    throw serviceError(
      ErrorCode.INVALID_COMMAND,
      'Process command must include an executable'
    );
  }
  for (const [index, argument] of command.entries()) {
    if (
      typeof argument !== 'string' ||
      (index === 0 && argument.length === 0)
    ) {
      throw serviceError(
        ErrorCode.INVALID_COMMAND,
        index === 0
          ? 'Process executable must be a non-empty string'
          : 'Process argv members must be strings'
      );
    }
  }
}

async function validateOptions(options: ProcessStartOptions): Promise<void> {
  if (!isPlainObject(options)) {
    throw serviceError(
      ErrorCode.INVALID_COMMAND,
      'Process options are invalid'
    );
  }
  if (options.cwd !== undefined) {
    if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
      throw invalidCwd(options.cwd, 'cwd must be a non-empty string');
    }
    try {
      const cwdStat = await stat(options.cwd);
      if (!cwdStat.isDirectory()) throw new Error('cwd is not a directory');
      await access(options.cwd, constants.X_OK);
    } catch (error) {
      throw invalidCwd(
        options.cwd,
        error instanceof Error ? error.message : 'cwd is not accessible'
      );
    }
  }
  if (options.env !== undefined) {
    if (!isPlainObject(options.env)) {
      throw invalidEnvironment(undefined, 'env must be a plain object');
    }
    for (const [name, value] of Object.entries(options.env)) {
      if (name.length === 0 || name.includes('=') || name.includes('\0')) {
        throw invalidEnvironment(name, 'environment name is invalid');
      }
      if (typeof value !== 'string') {
        throw invalidEnvironment(name, 'environment value must be a string');
      }
      if (value.includes('\0')) {
        throw invalidEnvironment(name, 'environment value contains a NUL byte');
      }
    }
  }
  if (
    options.timeout !== undefined &&
    (typeof options.timeout !== 'number' ||
      !Number.isFinite(options.timeout) ||
      options.timeout < 1)
  ) {
    throw serviceError(
      ErrorCode.INVALID_COMMAND,
      'Process timeout must be a positive finite number'
    );
  }
}

function validateCursor(cursor: string | undefined, processId: string): void {
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || cursor.length === 0)
  ) {
    throw serviceError(
      ErrorCode.INVALID_PROCESS_CURSOR,
      'Process log cursor is invalid',
      { processId, cursor, reason: 'cursor must be a non-empty string' }
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalidCwd(value: unknown, reason: string): ProcessServiceError {
  return serviceError(ErrorCode.INVALID_PROCESS_CWD, reason, {
    cwd: typeof value === 'string' ? value : String(value),
    reason
  });
}

function invalidEnvironment(
  name: string | undefined,
  reason: string
): ProcessServiceError {
  return serviceError(ErrorCode.INVALID_PROCESS_ENVIRONMENT, reason, {
    name,
    reason
  });
}

function isCwdSpawnFailure(error: unknown, cwd: string): boolean {
  if (!(error instanceof Error)) return false;
  const systemError: SystemError = error;
  return (
    systemError.path === cwd &&
    systemError.code !== undefined &&
    ['ENOENT', 'EACCES', 'ENOTDIR', 'EPERM'].includes(systemError.code)
  );
}

function statusToPublic(
  id: string,
  status: RuntimeProcessStatus
): ProcessStatus {
  const base = {
    id,
    pid: status.pid,
    command: status.command,
    cwd: status.cwd,
    startedAt: status.startedAt
  };
  if (status.state === 'running') return { ...base, state: 'running' };
  if (status.state === 'exited') {
    return {
      ...base,
      state: 'exited',
      exit: { ...status.exit },
      endedAt: status.endedAt
    };
  }
  return {
    ...base,
    state: 'error',
    error: { ...status.error },
    endedAt: status.endedAt
  };
}

function terminalTime(status: RuntimeProcessStatus): string {
  return status.state === 'running' ? status.startedAt : status.endedAt;
}

function durationBetween(
  startedAt: string,
  endedAt: string | undefined
): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt ?? new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function logEventToPublic(event: RuntimeProcessLogEvent): ProcessLogEvent {
  if (event.type === 'truncated') {
    return {
      type: 'truncated',
      cursor: event.cursor,
      timestamp: event.timestamp
    };
  }
  if (event.state === 'exited') {
    return {
      type: 'terminal',
      state: 'exited',
      cursor: event.cursor,
      timestamp: event.timestamp,
      exit: { ...event.exit }
    };
  }
  if (event.state === 'error') {
    return {
      type: 'terminal',
      state: 'error',
      cursor: event.cursor,
      timestamp: event.timestamp,
      error: { ...event.error }
    };
  }
  return {
    type: event.type,
    cursor: event.cursor,
    timestamp: event.timestamp,
    data: event.data
  };
}

function serviceError(
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | undefined>
): ProcessServiceError {
  return Object.assign(new Error(message), { code, details });
}
