import {
  StatelessCommandRunner,
  type StatelessProcess,
  StatelessProcessRunner
} from '@repo/sandbox-execution';
import type { ExecEvent, Logger } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import type {
  CommandErrorContext,
  CommandNotFoundContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
import {
  type ExecutionTarget,
  type ProcessCommandHandle,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../core/types';
import type { RawExecResult } from '../session-types';
import type { SessionManager } from './session-manager';

const SESSIONLESS_DISPLAY_NAME = 'sessionless';

type NestedExecutionOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  origin?: 'user' | 'internal';
};

type ExecutionCallback<T> = (
  exec: (
    command: string,
    options?: NestedExecutionOptions
  ) => Promise<RawExecResult>
) => Promise<T>;

export interface ExecutionOptions {
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  origin?: 'user' | 'internal';
}

export interface ProcessStreamStartOptions extends ExecutionOptions {
  onEvent: (event: ExecEvent) => Promise<void>;
  commandId: string;
}

export interface ProcessStreamStartResult {
  continueStreaming: Promise<void>;
  commandHandle: ProcessCommandHandle;
}

export class ExecutionService {
  private readonly statelessCommands = new StatelessCommandRunner();
  private readonly statelessProcesses = new StatelessProcessRunner();
  private readonly activeSessionlessProcesses = new Map<
    string,
    StatelessProcess
  >();

  constructor(
    private sessionManager: SessionManager,
    private logger: Logger
  ) {}

  async execute(
    command: string,
    options: ExecutionOptions = {}
  ): Promise<ServiceResult<RawExecResult>> {
    const target = this.resolveTarget(options.sessionId);

    if (target.kind === 'session') {
      return this.sessionManager.executeInSession(target.sessionId, command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        origin: options.origin
      });
    }

    return this.executeSessionless(command, options);
  }

  async startProcessStream(
    command: string,
    options: ProcessStreamStartOptions
  ): Promise<ServiceResult<ProcessStreamStartResult>> {
    const target = this.resolveTarget(options.sessionId);

    if (target.kind === 'session') {
      const result = await this.sessionManager.startProcessStreamInSession(
        target.sessionId,
        command,
        options.onEvent,
        {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeoutMs,
          origin: options.origin
        },
        options.commandId
      );

      if (!result.success) {
        return result as ServiceResult<ProcessStreamStartResult>;
      }

      return serviceSuccess({
        continueStreaming: result.data.continueStreaming,
        commandHandle: {
          target,
          commandId: options.commandId
        }
      });
    }

    return this.startSessionlessProcessStream(command, options);
  }

  async withExecution<T>(
    options: ExecutionOptions,
    fn: ExecutionCallback<T>
  ): Promise<ServiceResult<T>> {
    const target = this.resolveTarget(options.sessionId);

    if (target.kind === 'session') {
      // For session-backed execution, cwd is managed by the session shell and
      // passed as a one-time `cd` via withSession(). Inner calls must NOT
      // inherit the outer cwd or they would double-apply it.
      return this.sessionManager.withSession(
        target.sessionId,
        (exec) =>
          fn((command, execOptions) =>
            exec(
              command,
              this.mergeNestedExecutionOptions(options, execOptions, {
                inheritOuterCwd: false
              })
            )
          ),
        options.cwd
      );
    }
    // For sessionless execution, there is no persistent shell state, so the
    // outer cwd must flow through to each spawned process (inheritOuterCwd
    // defaults to true). Inner calls can still override it individually.

    try {
      const result = await fn((command, execOptions) =>
        this.executeSessionlessOrThrow(
          command,
          this.mergeNestedExecutionOptions(options, execOptions) ?? {}
        )
      );

      return serviceSuccess(result);
    } catch (error) {
      if (this.isServiceError(error)) {
        return serviceError({
          message: error.message,
          code: error.code,
          details: error.details
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError({
        message: `withExecution callback failed for sessionless execution: ${errorMessage}`,
        code: ErrorCode.INTERNAL_ERROR,
        details: {
          execution: SESSIONLESS_DISPLAY_NAME,
          originalError: errorMessage
        }
      });
    }
  }

  async kill(handle: ProcessCommandHandle): Promise<ServiceResult<void>> {
    if (handle.target.kind === 'session') {
      return this.sessionManager.killCommand(
        handle.target.sessionId,
        handle.commandId
      );
    }

    const process = this.activeSessionlessProcesses.get(handle.commandId);
    if (!process) {
      return serviceError({
        message: `Command '${handle.commandId}' not found or already completed in ${SESSIONLESS_DISPLAY_NAME} execution`,
        code: ErrorCode.COMMAND_NOT_FOUND,
        details: {
          command: handle.commandId
        } satisfies CommandNotFoundContext
      });
    }

    try {
      await process.kill();
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError({
        message: `Failed to kill command '${handle.commandId}' in ${SESSIONLESS_DISPLAY_NAME} execution: ${errorMessage}`,
        code: ErrorCode.PROCESS_ERROR,
        details: {
          processId: handle.commandId,
          stderr: errorMessage
        }
      });
    }
  }

  private resolveTarget(sessionId?: string): ExecutionTarget {
    if (sessionId === undefined || sessionId === DISABLE_SESSION_TOKEN) {
      return { kind: 'sessionless' };
    }

    if (sessionId.trim().length === 0) {
      throw new Error('sessionId must not be empty or whitespace');
    }

    return { kind: 'session', sessionId };
  }

  private mergeNestedExecutionOptions(
    defaults: ExecutionOptions,
    overrides?: NestedExecutionOptions,
    config: { inheritOuterCwd?: boolean } = {}
  ): NestedExecutionOptions | undefined {
    const cwd =
      overrides?.cwd ??
      (config.inheritOuterCwd !== false ? defaults.cwd : undefined);

    const merged: NestedExecutionOptions = {
      cwd,
      env:
        defaults.env || overrides?.env
          ? { ...defaults.env, ...overrides?.env }
          : undefined,
      timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs,
      origin: overrides?.origin ?? defaults.origin
    };

    return Object.values(merged).some((value) => value !== undefined)
      ? merged
      : undefined;
  }

  private async executeSessionless(
    command: string,
    options: ExecutionOptions
  ): Promise<ServiceResult<RawExecResult>> {
    const startTime = Date.now();
    const timestamp = new Date(startTime).toISOString();
    let outcome: 'success' | 'error' = 'error';
    let caughtError: Error | undefined;
    let exitCode: number | undefined;

    try {
      const result = await this.statelessCommands.exec(command, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs
      });

      exitCode = result.exitCode;
      outcome = 'success';

      return serviceSuccess({
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: Date.now() - startTime,
        timestamp
      });
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));

      return serviceError({
        message: `Failed to execute command '${command}' in ${SESSIONLESS_DISPLAY_NAME} execution: ${caughtError.message}`,
        code: ErrorCode.COMMAND_EXECUTION_ERROR,
        details: {
          command,
          stderr: caughtError.message
        } satisfies CommandErrorContext
      });
    } finally {
      logCanonicalEvent(this.logger, {
        event: 'sandbox.exec',
        outcome,
        command,
        exitCode,
        durationMs: Date.now() - startTime,
        sessionId: SESSIONLESS_DISPLAY_NAME,
        origin: options.origin ?? 'user',
        error: caughtError,
        errorMessage: caughtError?.message
      });
    }
  }

  private async executeSessionlessOrThrow(
    command: string,
    options: ExecutionOptions
  ): Promise<RawExecResult> {
    const result = await this.executeSessionless(command, options);

    if (!result.success) {
      throw result.error;
    }

    return result.data;
  }

  private async startSessionlessProcessStream(
    command: string,
    options: ProcessStreamStartOptions
  ): Promise<ServiceResult<ProcessStreamStartResult>> {
    const startEventSent = Promise.withResolvers<void>();
    startEventSent.promise.catch(() => {});

    try {
      const process = this.statelessProcesses.start(command, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        onOutput: async (chunk) => {
          await startEventSent.promise;
          await options.onEvent({
            type: chunk.stream,
            data: chunk.data,
            timestamp: new Date().toISOString()
          });
        }
      });
      const commandHandle: ProcessCommandHandle = {
        target: { kind: 'sessionless' },
        commandId: options.commandId,
        pid: process.pid
      };

      this.activeSessionlessProcesses.set(options.commandId, process);

      try {
        await options.onEvent({
          type: 'start',
          pid: process.pid,
          timestamp: new Date().toISOString()
        });
        startEventSent.resolve();
      } catch (error) {
        startEventSent.reject(error);
        await process.kill();
        this.activeSessionlessProcesses.delete(options.commandId);
        throw error;
      }

      const continueStreaming = this.continueSessionlessProcessStream(
        process,
        options
      );

      return serviceSuccess({
        continueStreaming,
        commandHandle
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError({
        message: `Failed to start process stream '${command}' in ${SESSIONLESS_DISPLAY_NAME} execution: ${errorMessage}`,
        code: ErrorCode.STREAM_START_ERROR,
        details: {
          command,
          stderr: errorMessage
        } satisfies CommandErrorContext
      });
    }
  }

  private async continueSessionlessProcessStream(
    process: StatelessProcess,
    options: ProcessStreamStartOptions
  ): Promise<void> {
    try {
      const result = await process.wait();

      await options.onEvent({
        type: 'complete',
        exitCode: result.exitCode,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      await options.onEvent({
        type: 'error',
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    } finally {
      this.activeSessionlessProcesses.delete(options.commandId);
    }
  }

  private isServiceError(error: unknown): error is {
    message: string;
    code: string;
    details?: Record<string, unknown>;
  } {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      'message' in error &&
      typeof (error as { code: unknown }).code === 'string' &&
      Object.values(ErrorCode).includes(
        (error as { code: string }).code as ErrorCode
      )
    );
  }
}
