import { constants, existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import {
  PtyProcess,
  type RuntimeTerminalOutputEvent,
  type RuntimeTerminalProcess
} from '@repo/sandbox-execution';
import {
  type CreateTerminalOptions,
  ErrorCode,
  type Logger,
  type SandboxTerminalsAPI,
  type TerminalOutputEvent,
  type TerminalSnapshot
} from '@repo/shared';
import { CONFIG } from '../config';

export const MAX_RETAINED_TERMINALS = 25;

export interface TerminalHandle {
  id: string;
  pty: RuntimeTerminalProcess;
}

interface TerminalRecord {
  id: string;
  command: CreateTerminalOptions['command'];
  cwd?: string;
  pty: RuntimeTerminalProcess;
  createdAt: number;
}

interface TerminalServiceError extends Error {
  code: string;
  details?: Record<string, string | number | boolean | undefined>;
}

export class TerminalManager {
  readonly #terminals = new Map<string, TerminalRecord>();
  readonly #terminalCreations = new Map<string, Promise<TerminalRecord>>();

  constructor(private readonly logger: Logger) {}

  getTerminal(id: string): TerminalHandle | undefined {
    const record = this.#terminals.get(id);
    return record ? { id: record.id, pty: record.pty } : undefined;
  }

  async create(options: CreateTerminalOptions): Promise<TerminalSnapshot> {
    validateCreateOptions(options);
    const id = crypto.randomUUID();
    const command: CreateTerminalOptions['command'] = [
      options.command[0],
      ...options.command.slice(1)
    ];
    const cwd = options.cwd ?? defaultTerminalCwd();
    const creation = validateTerminalCwd(cwd, id)
      .then(() =>
        PtyProcess.create({
          command,
          cwd,
          env: options.env,
          cols: options.cols,
          rows: options.rows,
          bufferSize: options.bufferSize,
          logger: this.logger
        })
      )
      .then((pty) => {
        const record: TerminalRecord = {
          id,
          command,
          cwd,
          pty,
          createdAt: Date.now()
        };
        this.#terminals.set(id, record);
        pty
          .waitForExit()
          .then(() => this.#enforceRetention())
          .catch(() => {});
        void this.#enforceRetention();
        return record;
      })
      .catch((error: unknown) => {
        if (isServiceError(error)) throw error;
        const message =
          error instanceof Error ? error.message : 'Terminal create failed';
        throw serviceError(ErrorCode.TERMINAL_CONTROL_ERROR, message, {
          terminalId: id,
          operation: 'create',
          reason: message
        });
      });
    this.#terminalCreations.set(id, creation);
    try {
      return snapshotToPublic(await creation);
    } finally {
      this.#terminalCreations.delete(id);
    }
  }

  async get(id: string): Promise<TerminalSnapshot | null> {
    const record = this.#terminals.get(id);
    return record ? snapshotToPublic(record) : null;
  }

  async list(): Promise<TerminalSnapshot[]> {
    return [...this.#terminals.values()].map(snapshotToPublic);
  }

  async output(
    id: string,
    options: Parameters<SandboxTerminalsAPI['output']>[1] = {}
  ): Promise<ReadableStream<TerminalOutputEvent>> {
    validateCursor(options.since, id);
    const record = this.#require(id);
    try {
      return record.pty
        .output({
          after: options.since,
          replay: options.replay,
          follow: options.follow
        })
        .pipeThrough(
          new TransformStream({
            transform(event: RuntimeTerminalOutputEvent, controller) {
              controller.enqueue(outputToPublic(id, event));
            }
          })
        );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Terminal output cursor is invalid';
      throw serviceError(ErrorCode.INVALID_TERMINAL_CURSOR, message, {
        terminalId: id,
        cursor: options.since,
        reason: message
      });
    }
  }

  async write(id: string, data: Uint8Array): Promise<void> {
    await this.#control(id, 'write', (pty) => pty.write(data));
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.#control(id, 'resize', (pty) =>
      Promise.resolve(pty.resize(cols, rows))
    );
  }

  async interrupt(id: string): Promise<void> {
    await this.#control(id, 'interrupt', (pty) => pty.interrupt());
  }

  async terminate(id: string): Promise<void> {
    await this.#control(id, 'terminate', (pty) => pty.terminate());
  }

  async hasActive(): Promise<boolean> {
    return [...this.#terminals.values()].some(
      (record) => record.pty.snapshot().state === 'running'
    );
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.#terminalCreations.values()].map((p) => p.catch(() => {}))
    );
    await Promise.all(
      [...this.#terminals.values()].map((record) => record.pty.close())
    );
    this.#terminals.clear();
  }

  #require(id: string): TerminalRecord {
    const record = this.#terminals.get(id);
    if (!record)
      throw serviceError(ErrorCode.TERMINAL_NOT_FOUND, 'Terminal not found', {
        terminalId: id
      });
    return record;
  }

  async #control(
    id: string,
    operationName: string,
    operation: (pty: RuntimeTerminalProcess) => Promise<void>
  ): Promise<void> {
    try {
      await operation(this.#require(id).pty);
    } catch (error) {
      if (isServiceError(error)) throw error;
      const message =
        error instanceof Error
          ? error.message
          : 'Terminal control operation failed';
      throw serviceError(ErrorCode.TERMINAL_CONTROL_ERROR, message, {
        terminalId: id,
        operation: operationName,
        reason: message
      });
    }
  }

  async #enforceRetention(): Promise<void> {
    const exited = [...this.#terminals.values()]
      .filter((record) => record.pty.snapshot().state !== 'running')
      .sort((a, b) => a.createdAt - b.createdAt);
    while (exited.length > MAX_RETAINED_TERMINALS) {
      const record = exited.shift();
      if (record) this.#terminals.delete(record.id);
    }
  }
}

function snapshotToPublic(record: TerminalRecord): TerminalSnapshot {
  const snapshot = record.pty.snapshot();
  return {
    id: record.id,
    pid: snapshot.pid,
    command: [...record.command],
    cwd: record.cwd,
    status: snapshot.state,
    exit: snapshot.state === 'exited' ? { ...snapshot.exit } : undefined,
    error: snapshot.state === 'error' ? { ...snapshot.error } : undefined
  };
}

function outputToPublic(
  terminalId: string,
  event: RuntimeTerminalOutputEvent
): TerminalOutputEvent {
  if (event.type === 'data') return { ...event, terminalId };
  if (event.type === 'terminal') {
    if (event.state === 'exited') {
      return {
        type: 'terminal',
        terminalId,
        cursor: event.cursor,
        timestamp: event.timestamp,
        state: 'exited',
        exit: { ...event.exit }
      };
    }
    return {
      type: 'terminal',
      terminalId,
      cursor: event.cursor,
      timestamp: event.timestamp,
      state: 'error',
      error: { ...event.error }
    };
  }
  return { ...event, terminalId };
}

function defaultTerminalCwd(): string {
  return existsSync(CONFIG.DEFAULT_CWD) ? CONFIG.DEFAULT_CWD : process.cwd();
}

async function validateTerminalCwd(
  cwd: string,
  terminalId: string
): Promise<void> {
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error('cwd is not a directory');
    await access(cwd, constants.X_OK);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Terminal cwd is invalid';
    throw serviceError(ErrorCode.INVALID_TERMINAL_CWD, reason, {
      terminalId,
      cwd,
      operation: 'create',
      reason
    });
  }
}

function validateCreateOptions(options: CreateTerminalOptions): void {
  if (!Array.isArray(options.command) || options.command.length === 0)
    throw serviceError(
      ErrorCode.INVALID_COMMAND,
      'Terminal command must include an executable'
    );
  if (typeof options.command[0] !== 'string' || options.command[0].length === 0)
    throw serviceError(
      ErrorCode.INVALID_COMMAND,
      'Terminal command must include an executable'
    );
  for (const arg of options.command) {
    if (typeof arg !== 'string')
      throw serviceError(
        ErrorCode.INVALID_COMMAND,
        'Terminal argv members must be strings'
      );
  }
}

function validateCursor(cursor: string | undefined, terminalId: string): void {
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || cursor.length === 0)
  ) {
    throw serviceError(
      ErrorCode.INVALID_TERMINAL_CURSOR,
      'Terminal output cursor is invalid',
      { terminalId, cursor, reason: 'cursor must be a non-empty string' }
    );
  }
}

function serviceError(
  code: string,
  message: string,
  details?: Record<string, string | number | boolean | undefined>
): TerminalServiceError {
  return Object.assign(new Error(message), { code, details });
}

function isServiceError(error: unknown): error is TerminalServiceError {
  return error instanceof Error && 'code' in error;
}
