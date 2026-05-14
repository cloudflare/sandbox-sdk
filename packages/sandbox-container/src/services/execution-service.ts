import { existsSync } from 'node:fs';
import type { ExecEvent } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import { spawn } from 'bun';
import type {
  ExecutionTarget,
  ProcessCommandHandle,
  ServiceResult
} from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import type { RawExecResult } from '../session';
import type { SessionManager } from './session-manager';

export const SESSIONLESS_SESSION_ID = 'none';
const SESSIONLESS_SESSION_ID_ALIASES = new Set(['none', 'sessionless']);

const DEFAULT_CWD = existsSync('/workspace') ? '/workspace' : process.cwd();
const SETSID_PATH = existsSync('/usr/bin/setsid') ? '/usr/bin/setsid' : null;

function sessionlessCmd(command: string): string[] {
  return SETSID_PATH !== null
    ? [SETSID_PATH, 'bash', '-lc', command]
    : ['bash', '-lc', command];
}

function sessionlessKillPid(pid: number): number {
  return SETSID_PATH !== null ? -pid : pid;
}

export interface ExecutionOptions {
  target?: ExecutionTarget;
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  origin?: 'user' | 'internal';
}

export interface ExecutionStreamOptions {
  target?: ExecutionTarget;
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  origin?: 'user' | 'internal';
  commandId: string;
  background?: boolean;
}

export interface ExecutionStreamResult {
  continueStreaming: Promise<void>;
  commandHandle: ProcessCommandHandle;
}

export type ExecutionCallback = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    origin?: 'user' | 'internal';
  }
) => Promise<RawExecResult>;

export function isSessionlessSessionId(sessionId: string | undefined): boolean {
  return (
    sessionId !== undefined &&
    SESSIONLESS_SESSION_ID_ALIASES.has(sessionId.trim().toLowerCase())
  );
}

export function canonicalizeExecutionSessionId(options: {
  sessionId?: string;
  fallbackSessionId?: string;
}): string {
  if (isSessionlessSessionId(options.sessionId)) {
    return SESSIONLESS_SESSION_ID;
  }

  if (options.sessionId && options.sessionId.trim().length > 0) {
    return options.sessionId.trim();
  }

  if (
    options.fallbackSessionId &&
    options.fallbackSessionId.trim().length > 0
  ) {
    return options.fallbackSessionId.trim();
  }

  return 'default';
}

export class ExecutionService {
  constructor(private sessionManager: SessionManager) {}

  resolveTarget(options: {
    target?: ExecutionTarget;
    sessionId?: string;
  }): ExecutionTarget {
    if (options.target) {
      return options.target;
    }

    if (isSessionlessSessionId(options.sessionId)) {
      return { mode: 'sessionless' };
    }

    return {
      mode: 'session',
      sessionId:
        options.sessionId && options.sessionId.trim().length > 0
          ? options.sessionId.trim()
          : 'default'
    };
  }

  targetToSessionId(target: ExecutionTarget): string | undefined {
    if (target.mode === 'session') {
      return target.sessionId;
    }

    return SESSIONLESS_SESSION_ID;
  }

  async execute(
    command: string,
    options: ExecutionOptions = {}
  ): Promise<ServiceResult<RawExecResult>> {
    const target = this.resolveTarget(options);

    if (target.mode === 'session') {
      return this.sessionManager.executeInSession(target.sessionId!, command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        origin: options.origin
      });
    }

    return this.executeOneShot(command, options);
  }

  async withExecution<T>(
    fn: (exec: ExecutionCallback) => Promise<T>,
    options: {
      target?: ExecutionTarget;
      sessionId?: string;
      cwd?: string;
    } = {}
  ): Promise<ServiceResult<T>> {
    const target = this.resolveTarget(options);

    if (target.mode === 'session') {
      return this.sessionManager.withSession(
        target.sessionId!,
        fn,
        options.cwd
      );
    }

    try {
      const result = await fn((command, execOptions) =>
        this.executeOneShot(command, {
          cwd: execOptions?.cwd ?? options.cwd,
          env: execOptions?.env,
          timeoutMs: execOptions?.timeoutMs,
          origin: execOptions?.origin
        }).then((executionResult) => {
          if (!executionResult.success) {
            throw executionResult.error;
          }

          return executionResult.data;
        })
      );

      return serviceSuccess(result);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        'message' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        Object.values(ErrorCode).includes(
          (error as { code: string }).code as ErrorCode
        )
      ) {
        const customError = error as {
          message: string;
          code: string;
          details?: Record<string, unknown>;
        };
        return serviceError<T>({
          message: customError.message,
          code: customError.code,
          details: customError.details
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError<T>({
        message: `withExecution callback failed for '${SESSIONLESS_SESSION_ID}': ${errorMessage}`,
        code: ErrorCode.INTERNAL_ERROR,
        details: {
          sessionId: SESSIONLESS_SESSION_ID,
          originalError: errorMessage
        }
      });
    }
  }

  async executeStream(
    command: string,
    onEvent: (event: ExecEvent) => Promise<void>,
    options: ExecutionStreamOptions
  ): Promise<ServiceResult<ExecutionStreamResult>> {
    const target = this.resolveTarget(options);

    if (target.mode === 'session') {
      const result = await this.sessionManager.executeStreamInSession(
        target.sessionId!,
        command,
        onEvent,
        {
          cwd: options.cwd,
          env: options.env,
          origin: options.origin
        },
        options.commandId,
        { background: options.background }
      );

      if (!result.success) {
        return result as ServiceResult<ExecutionStreamResult>;
      }

      return serviceSuccess({
        continueStreaming: result.data.continueStreaming,
        commandHandle: {
          mode: 'session',
          sessionId: target.sessionId!,
          commandId: options.commandId
        }
      });
    }

    return this.executeStreamOneShot(command, onEvent, options);
  }

  async kill(
    commandHandle: ProcessCommandHandle
  ): Promise<ServiceResult<void>> {
    if (commandHandle.mode === 'session') {
      return this.sessionManager.killCommand(
        commandHandle.sessionId,
        commandHandle.commandId
      );
    }

    if (commandHandle.pid <= 0) {
      return serviceError({
        message: `Invalid PID ${commandHandle.pid}`,
        code: ErrorCode.PROCESS_ERROR,
        details: { processId: String(commandHandle.pid) }
      });
    }

    try {
      process.kill(sessionlessKillPid(commandHandle.pid), 'SIGTERM');
      const pid = commandHandle.pid;
      setTimeout(() => {
        try {
          process.kill(sessionlessKillPid(pid), 'SIGKILL');
        } catch {
          // Process already exited — expected
        }
      }, 5000).unref();
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errorCode =
        error instanceof Error && 'code' in error && error.code === 'ESRCH'
          ? ErrorCode.PROCESS_NOT_FOUND
          : ErrorCode.PROCESS_ERROR;

      return serviceError({
        message: `Failed to kill process '${commandHandle.pid}': ${errorMessage}`,
        code: errorCode,
        details: {
          processId: String(commandHandle.pid),
          stderr: errorMessage
        }
      });
    }
  }

  private async executeOneShot(
    command: string,
    options: Omit<ExecutionOptions, 'target' | 'sessionId'>
  ): Promise<ServiceResult<RawExecResult>> {
    const startTime = Date.now();
    let timedOut = false;
    let subprocessPid: number | undefined;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (subprocessPid !== undefined) {
              try {
                process.kill(sessionlessKillPid(subprocessPid), 'SIGKILL');
              } catch {
                // Process already exited
              }
            }
          }, options.timeoutMs);

    try {
      const env = Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      );
      const subprocess = spawn({
        cmd: sessionlessCmd(command),
        cwd: options.cwd ?? DEFAULT_CWD,
        env: {
          ...process.env,
          ...env
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore'
      });

      subprocessPid = subprocess.pid;

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited
      ]);

      if (timedOut) {
        return serviceSuccess({
          stdout,
          stderr: stderr || `Command timed out after ${options.timeoutMs}ms`,
          exitCode: 124,
          command,
          duration: Date.now() - startTime,
          timestamp: new Date(startTime).toISOString()
        });
      }

      return serviceSuccess({
        stdout,
        stderr,
        exitCode,
        command,
        duration: Date.now() - startTime,
        timestamp: new Date(startTime).toISOString()
      });
    } catch (error) {
      if (timedOut) {
        return serviceSuccess({
          stdout: '',
          stderr: `Command timed out after ${options.timeoutMs}ms`,
          exitCode: 124,
          command,
          duration: Date.now() - startTime,
          timestamp: new Date(startTime).toISOString()
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError({
        message: `Failed to execute command '${command}': ${errorMessage}`,
        code: ErrorCode.COMMAND_EXECUTION_ERROR,
        details: {
          command,
          stderr: errorMessage
        }
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async executeStreamOneShot(
    command: string,
    onEvent: (event: ExecEvent) => Promise<void>,
    options: Omit<ExecutionStreamOptions, 'target' | 'sessionId'>
  ): Promise<ServiceResult<ExecutionStreamResult>> {
    const startTime = Date.now();
    let timedOut = false;
    let subprocessPid: number | undefined;
    const timeoutHandle =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            if (subprocessPid !== undefined) {
              try {
                process.kill(sessionlessKillPid(subprocessPid), 'SIGKILL');
              } catch {
                // Process already exited
              }
            }
          }, options.timeoutMs);

    try {
      const env = Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      );
      const subprocess = spawn({
        cmd: sessionlessCmd(command),
        cwd: options.cwd ?? DEFAULT_CWD,
        env: {
          ...process.env,
          ...env
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore'
      });

      subprocessPid = subprocess.pid;

      const commandHandle: ProcessCommandHandle = {
        mode: 'sessionless',
        pid: subprocess.pid
      };

      await onEvent({
        type: 'start',
        timestamp: new Date().toISOString(),
        command,
        pid: subprocess.pid,
        sessionId: SESSIONLESS_SESSION_ID
      });

      const streamOutput = async (
        stream: ReadableStream<Uint8Array> | null,
        type: 'stdout' | 'stderr'
      ) => {
        if (!stream) {
          return;
        }

        const decoder = new TextDecoder();
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            const data = decoder.decode(value, { stream: true });
            if (data.length > 0) {
              await onEvent({
                type,
                timestamp: new Date().toISOString(),
                data,
                command,
                sessionId: SESSIONLESS_SESSION_ID
              });
            }
          }

          const remaining = decoder.decode();
          if (remaining.length > 0) {
            await onEvent({
              type,
              timestamp: new Date().toISOString(),
              data: remaining,
              command,
              sessionId: SESSIONLESS_SESSION_ID
            });
          }
        } finally {
          reader.releaseLock();
        }
      };

      const continueStreaming = Promise.all([
        streamOutput(subprocess.stdout, 'stdout'),
        streamOutput(subprocess.stderr, 'stderr'),
        subprocess.exited
      ])
        .then(async ([, , exitCode]) => {
          if (timedOut) {
            await onEvent({
              type: 'error',
              timestamp: new Date().toISOString(),
              error: `Command timed out after ${options.timeoutMs}ms`,
              exitCode: 124,
              command,
              sessionId: SESSIONLESS_SESSION_ID
            });
            return;
          }

          await onEvent({
            type: 'complete',
            timestamp: new Date().toISOString(),
            exitCode,
            command,
            sessionId: SESSIONLESS_SESSION_ID
          });
        })
        .catch(async (error) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          await onEvent({
            type: 'error',
            timestamp: new Date().toISOString(),
            error: errorMessage,
            command,
            sessionId: SESSIONLESS_SESSION_ID
          });
        })
        .finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        });

      return serviceSuccess({
        continueStreaming,
        commandHandle
      });
    } catch (error) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError({
        message: `Failed to start streaming command '${command}': ${errorMessage}`,
        code: ErrorCode.STREAM_START_ERROR,
        details: {
          command,
          stderr: errorMessage,
          durationMs: Date.now() - startTime
        }
      });
    }
  }
}
