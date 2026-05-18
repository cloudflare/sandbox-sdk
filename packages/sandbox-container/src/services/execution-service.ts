import type { ExecEvent, Logger } from '@repo/shared';
import { logCanonicalEvent } from '@repo/shared';
import type {
  CommandErrorContext,
  CommandNotFoundContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import {
  type ProcessCommandHandle,
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../core/types';
import type { RawExecResult } from '../session';
import type { SessionManager } from './session-manager';

const BASH_PATH = '/bin/bash';
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_CWD = '/workspace';
const SESSIONLESS_SESSION_ID = 'none';
const SESSIONLESS_TIMEOUT_EXIT_CODE = 124;
const SESSIONLESS_KILL_GRACE_PERIOD_MS = 5_000;
const SESSIONLESS_FORCE_KILL_WAIT_MS = 1_000;

type ExecutionTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'sessionless' };

type ExecutionCallback<T> = (
  exec: (
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeoutMs?: number;
      origin?: 'user' | 'internal';
    }
  ) => Promise<RawExecResult>
) => Promise<T>;

type SpawnedExecutionProcess = {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

export interface ExecutionOptions {
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  origin?: 'user' | 'internal';
}

export interface ExecutionStreamOptions extends ExecutionOptions {
  onEvent: (event: ExecEvent) => Promise<void>;
  commandId: string;
  background?: boolean;
}

export interface ExecutionStreamResult {
  continueStreaming: Promise<void>;
  commandHandle: ProcessCommandHandle;
}

export class ExecutionService {
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

  async executeStream(
    command: string,
    options: ExecutionStreamOptions
  ): Promise<ServiceResult<ExecutionStreamResult>> {
    const target = this.resolveTarget(options.sessionId);

    if (target.kind === 'session') {
      const result = await this.sessionManager.executeStreamInSession(
        target.sessionId,
        command,
        options.onEvent,
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
          sessionId: target.sessionId,
          commandId: options.commandId
        }
      });
    }

    return this.executeStreamSessionless(command, options);
  }

  async withExecution<T>(
    options: ExecutionOptions,
    fn: ExecutionCallback<T>
  ): Promise<ServiceResult<T>> {
    const target = this.resolveTarget(options.sessionId);

    if (target.kind === 'session') {
      return this.sessionManager.withSession(target.sessionId, fn, options.cwd);
    }

    try {
      const result = await fn((command, execOptions) =>
        this.executeSessionlessOrThrow(command, {
          sessionId: SESSIONLESS_SESSION_ID,
          cwd: execOptions?.cwd ?? options.cwd,
          env: execOptions?.env,
          timeoutMs: execOptions?.timeoutMs,
          origin: execOptions?.origin
        })
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
          sessionId: SESSIONLESS_SESSION_ID,
          originalError: errorMessage
        }
      });
    }
  }

  async kill(handle: ProcessCommandHandle): Promise<ServiceResult<void>> {
    const target = this.resolveTarget(handle.sessionId);

    if (target.kind === 'session') {
      return this.sessionManager.killCommand(
        target.sessionId,
        handle.commandId
      );
    }

    if (handle.pid === undefined || !this.processExists(handle.pid)) {
      return serviceError({
        message: `Command '${handle.commandId}' not found or already completed in session '${SESSIONLESS_SESSION_ID}'`,
        code: ErrorCode.COMMAND_NOT_FOUND,
        details: {
          command: handle.commandId
        } satisfies CommandNotFoundContext
      });
    }

    try {
      await this.terminateProcessTree(handle.pid);
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return serviceError({
        message: `Failed to kill command '${handle.commandId}' in session '${SESSIONLESS_SESSION_ID}': ${errorMessage}`,
        code: ErrorCode.PROCESS_ERROR,
        details: {
          processId: handle.commandId,
          stderr: errorMessage
        }
      });
    }
  }

  private resolveTarget(sessionId?: string): ExecutionTarget {
    const resolved = this.canonicalizeExecutionSessionId(sessionId);

    return resolved === SESSIONLESS_SESSION_ID
      ? { kind: 'sessionless' }
      : { kind: 'session', sessionId: resolved };
  }

  private canonicalizeExecutionSessionId(sessionId?: string): string {
    if (sessionId && sessionId.trim().length > 0) {
      return sessionId;
    }

    return DEFAULT_SESSION_ID;
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
      const spawned = this.spawnSessionlessProcess(command, options);
      const stdoutPromise = this.readStreamText(spawned.stdout);
      const stderrPromise = this.readStreamText(spawned.stderr);
      const completion = await this.waitForProcessCompletion(
        spawned,
        options.timeoutMs
      );
      const [stdout, stderr] = await Promise.all([
        stdoutPromise,
        stderrPromise
      ]);
      const finalStderr = completion.timedOut
        ? this.appendLine(
            stderr,
            `Command timed out after ${options.timeoutMs}ms`
          )
        : stderr;

      exitCode = completion.exitCode;
      outcome = 'success';

      return serviceSuccess({
        command,
        stdout,
        stderr: finalStderr,
        exitCode: completion.exitCode,
        duration: Date.now() - startTime,
        timestamp
      });
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));

      return serviceError({
        message: `Failed to execute command '${command}' in session '${SESSIONLESS_SESSION_ID}': ${caughtError.message}`,
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
        sessionId: SESSIONLESS_SESSION_ID,
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

  private async executeStreamSessionless(
    command: string,
    options: ExecutionStreamOptions
  ): Promise<ServiceResult<ExecutionStreamResult>> {
    try {
      const spawned = this.spawnSessionlessProcess(command, options);
      const commandHandle: ProcessCommandHandle = {
        sessionId: SESSIONLESS_SESSION_ID,
        commandId: options.commandId,
        pid: spawned.pid
      };

      await options.onEvent({
        type: 'start',
        pid: spawned.pid,
        timestamp: new Date().toISOString()
      });

      const continueStreaming = this.continueSessionlessStreaming(
        spawned,
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
        message: `Failed to execute streaming command '${command}' in session '${SESSIONLESS_SESSION_ID}': ${errorMessage}`,
        code: ErrorCode.STREAM_START_ERROR,
        details: {
          command,
          stderr: errorMessage
        } satisfies CommandErrorContext
      });
    }
  }

  private async continueSessionlessStreaming(
    spawned: SpawnedExecutionProcess,
    options: ExecutionStreamOptions
  ): Promise<void> {
    const stdoutPromise = this.pipeStreamToEvents(
      spawned.stdout,
      'stdout',
      options.onEvent
    );
    const stderrPromise = this.pipeStreamToEvents(
      spawned.stderr,
      'stderr',
      options.onEvent
    );

    try {
      const completion = await this.waitForProcessCompletion(
        spawned,
        options.timeoutMs
      );
      await Promise.all([stdoutPromise, stderrPromise]);

      if (completion.timedOut) {
        await options.onEvent({
          type: 'stderr',
          data: `Command timed out after ${options.timeoutMs}ms\n`,
          timestamp: new Date().toISOString()
        });
      }

      await options.onEvent({
        type: 'complete',
        exitCode: completion.exitCode,
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
    }
  }

  private spawnSessionlessProcess(
    command: string,
    options: ExecutionOptions
  ): SpawnedExecutionProcess {
    return Bun.spawn([BASH_PATH, '-lc', command], {
      cwd: options.cwd ?? DEFAULT_CWD,
      env: this.buildEnv(options.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true
    });
  }

  private buildEnv(
    env?: Record<string, string | undefined>
  ): Record<string, string> {
    const merged: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }

    for (const [key, value] of Object.entries(env ?? {})) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }

    return merged;
  }

  private async waitForProcessCompletion(
    spawned: SpawnedExecutionProcess,
    timeoutMs?: number
  ): Promise<{ exitCode: number; timedOut: boolean }> {
    if (timeoutMs === undefined) {
      return { exitCode: await spawned.exited, timedOut: false };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const exitCode = await Promise.race<number>([
        spawned.exited,
        new Promise<number>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);

      return { exitCode, timedOut: false };
    } catch {
      await this.terminateProcessTree(spawned.pid);
      await spawned.exited.catch(() => {});

      return {
        exitCode: SESSIONLESS_TIMEOUT_EXIT_CODE,
        timedOut: true
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async terminateProcessTree(pid: number): Promise<void> {
    this.killProcessGroup(pid, 'SIGTERM');

    if (
      await this.waitForProcessTreeExit(pid, SESSIONLESS_KILL_GRACE_PERIOD_MS)
    ) {
      return;
    }

    this.killProcessGroup(pid, 'SIGKILL');
    await this.waitForProcessTreeExit(pid, SESSIONLESS_FORCE_KILL_WAIT_MS);
  }

  private killProcessGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}

    try {
      process.kill(pid, signal);
    } catch {}
  }

  private async waitForProcessTreeExit(
    pid: number,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.processExists(pid)) {
        return true;
      }

      await Bun.sleep(50);
    }

    return !this.processExists(pid);
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async readStreamText(
    stream: ReadableStream<Uint8Array> | null
  ): Promise<string> {
    if (!stream) {
      return '';
    }

    return await new Response(stream).text();
  }

  private async pipeStreamToEvents(
    stream: ReadableStream<Uint8Array> | null,
    type: 'stdout' | 'stderr',
    onEvent: (event: ExecEvent) => Promise<void>
  ): Promise<void> {
    if (!stream) {
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          const remaining = decoder.decode();
          if (remaining.length > 0) {
            await onEvent({
              type,
              data: remaining,
              timestamp: new Date().toISOString()
            });
          }
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        if (chunk.length > 0) {
          await onEvent({
            type,
            data: chunk,
            timestamp: new Date().toISOString()
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private appendLine(existing: string, nextLine: string): string {
    if (existing.length === 0) {
      return nextLine;
    }

    return existing.endsWith('\n')
      ? `${existing}${nextLine}`
      : `${existing}\n${nextLine}`;
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
