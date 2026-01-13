// SessionManager Service - Manages persistent execution sessions

import {
  type ExecEvent,
  type Logger,
  partitionEnvVars,
  shellEscape
} from '@repo/shared';
import type {
  CommandErrorContext,
  CommandNotFoundContext,
  InternalErrorContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import { Mutex } from 'async-mutex';
import {
  type ServiceResult,
  serviceError,
  serviceSuccess
} from '../core/types';
import { type RawExecResult, Session, type SessionOptions } from '../session';

/**
 * SessionManager manages persistent execution sessions.
 * Wraps the session.ts Session class with ServiceResult<T> pattern.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Per-session mutexes to prevent concurrent command execution */
  private sessionLocks = new Map<string, Mutex>();
  /** Tracks in-progress session creation to prevent duplicate creation races */
  private creatingLocks = new Map<string, Promise<Session>>();

  constructor(private logger: Logger) {}

  /**
   * Get or create a mutex for a specific session
   */
  private getSessionLock(sessionId: string): Mutex {
    let lock = this.sessionLocks.get(sessionId);
    if (!lock) {
      lock = new Mutex();
      this.sessionLocks.set(sessionId, lock);
    }
    return lock;
  }

  /**
   * Get or create a session with coordination to prevent race conditions.
   * If multiple requests try to create the same session simultaneously,
   * only one will create it and others will wait for that result.
   *
   * Uses a two-phase approach:
   * 1. Check if session exists (fast path)
   * 2. Use creatingLocks map to coordinate creation across callers
   *
   * IMPORTANT: All callers (executeInSession, withSession, etc.) acquire the
   * session lock before calling this method. The lock ensures only one caller
   * executes this method at a time for a given sessionId, making the
   * creatingLocks check-and-set atomic.
   */
  private async getOrCreateSession(
    sessionId: string,
    options: { cwd?: string; commandTimeoutMs?: number } = {}
  ): Promise<ServiceResult<Session>> {
    // Fast path: session already exists
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { success: true, data: existing };
    }

    // Check if another request is already creating this session
    // Since we're called under the session lock, only one caller can reach here
    // at a time for the same sessionId
    const pendingCreate = this.creatingLocks.get(sessionId);
    if (pendingCreate) {
      try {
        const session = await pendingCreate;
        return { success: true, data: session };
      } catch (error) {
        // Creation failed, will retry below
      }
    }

    // We need to create the session - set up coordination
    // Since we hold the lock, we can safely set creatingLocks without race
    const createPromise = (async (): Promise<Session> => {
      const session = new Session({
        id: sessionId,
        cwd: options.cwd || '/workspace',
        commandTimeoutMs: options.commandTimeoutMs,
        logger: this.logger
      });
      await session.initialize();
      this.sessions.set(sessionId, session);
      return session;
    })();

    this.creatingLocks.set(sessionId, createPromise);

    try {
      const session = await createPromise;
      return { success: true, data: session };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to create session',
        error instanceof Error ? error : undefined,
        {
          sessionId,
          originalError: errorMessage
        }
      );

      return {
        success: false,
        error: {
          message: `Failed to create session '${sessionId}': ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            sessionId,
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    } finally {
      this.creatingLocks.delete(sessionId);
      // Clean up orphaned lock if session creation failed
      if (!this.sessions.has(sessionId)) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /**
   * Create a new persistent session
   */
  async createSession(
    options: SessionOptions
  ): Promise<ServiceResult<Session>> {
    try {
      // Check if session already exists
      if (this.sessions.has(options.id)) {
        return {
          success: false,
          error: {
            message: `Session '${options.id}' already exists`,
            code: ErrorCode.SESSION_ALREADY_EXISTS,
            details: {
              sessionId: options.id
            }
          }
        };
      }

      // Create and initialize session - pass logger with sessionId context
      const session = new Session({
        ...options,
        logger: this.logger
      });
      await session.initialize();

      this.sessions.set(options.id, session);

      return {
        success: true,
        data: session
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        'Failed to create session',
        error instanceof Error ? error : undefined,
        {
          sessionId: options.id,
          originalError: errorMessage
        }
      );

      return {
        success: false,
        error: {
          message: `Failed to create session '${options.id}': ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            sessionId: options.id,
            originalError: errorMessage,
            stack: errorStack
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * Get an existing session
   */
  async getSession(sessionId: string): Promise<ServiceResult<Session>> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return {
        success: false,
        error: {
          message: `Session '${sessionId}' not found`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            sessionId,
            originalError: 'Session not found'
          } satisfies InternalErrorContext
        }
      };
    }

    return {
      success: true,
      data: session
    };
  }

  /**
   * Get session info (cwd, env) for PTY attachment.
   * Returns null if session doesn't exist.
   */
  getSessionInfo(
    sessionId: string
  ): { cwd: string; env?: Record<string, string | undefined> } | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return {
      cwd: session.getInitialCwd(),
      env: session.getInitialEnv()
    };
  }

  /**
   * Execute a command in a session with per-session locking.
   * Commands to the same session are serialized; different sessions run in parallel.
   */
  async executeInSession(
    sessionId: string,
    command: string,
    cwd?: string,
    timeoutMs?: number,
    env?: Record<string, string | undefined>
  ): Promise<ServiceResult<RawExecResult>> {
    const lock = this.getSessionLock(sessionId);

    return lock.runExclusive(async () => {
      try {
        // Get or create session (coordinated)
        const sessionResult = await this.getOrCreateSession(sessionId, {
          cwd: cwd || '/workspace',
          commandTimeoutMs: timeoutMs
        });

        if (!sessionResult.success) {
          return sessionResult as ServiceResult<RawExecResult>;
        }

        const session = sessionResult.data;

        const result = await session.exec(
          command,
          cwd || env ? { cwd, env } : undefined
        );

        return {
          success: true,
          data: result
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          'Failed to execute command',
          error instanceof Error ? error : undefined,
          {
            sessionId,
            command
          }
        );

        return {
          success: false,
          error: {
            message: `Failed to execute command '${command}' in session '${sessionId}': ${errorMessage}`,
            code: ErrorCode.COMMAND_EXECUTION_ERROR,
            details: {
              command,
              stderr: errorMessage
            } satisfies CommandErrorContext
          }
        };
      }
    });
  }

  /**
   * Execute multiple commands atomically within a session.
   * The lock is held for the entire callback duration, preventing
   * other operations from interleaving.
   *
   * WARNING: Do not call withSession or executeInSession recursively on the same
   * session - it will deadlock. Cross-session calls are safe.
   *
   * @param sessionId - The session identifier
   * @param fn - Callback that receives an exec function for running commands
   * @param cwd - Optional working directory for session creation
   * @returns The result of the callback wrapped in ServiceResult
   */
  async withSession<T>(
    sessionId: string,
    fn: (
      exec: (
        command: string,
        options?: { cwd?: string; env?: Record<string, string | undefined> }
      ) => Promise<RawExecResult>
    ) => Promise<T>,
    cwd?: string
  ): Promise<ServiceResult<T>> {
    const lock = this.getSessionLock(sessionId);

    return lock.runExclusive(async (): Promise<ServiceResult<T>> => {
      try {
        // Get or create session (coordinated)
        const sessionResult = await this.getOrCreateSession(sessionId, {
          cwd: cwd || '/workspace'
        });

        if (!sessionResult.success) {
          return serviceError<T>(sessionResult.error);
        }

        const session = sessionResult.data;

        // Provide exec function that uses the session directly (already under lock)
        const exec = async (
          command: string,
          options?: { cwd?: string; env?: Record<string, string | undefined> }
        ): Promise<RawExecResult> => {
          return session.exec(command, options);
        };

        const result = await fn(exec);

        return serviceSuccess<T>(result);
      } catch (error) {
        // Check if error is a ServiceError-like object (from service callbacks)
        // Validates that code is a known ErrorCode to avoid catching unrelated objects
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
        this.logger.error(
          'withSession callback failed',
          error instanceof Error ? error : undefined,
          { sessionId }
        );

        return serviceError<T>({
          message: `withSession callback failed for session '${sessionId}': ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            sessionId,
            originalError: errorMessage
          } satisfies InternalErrorContext
        });
      }
    });
  }

  /**
   * Execute a command with streaming output.
   *
   * @param sessionId - The session identifier
   * @param command - The command to execute
   * @param onEvent - Callback for streaming events
   * @param options - Optional cwd and env overrides
   * @param commandId - Required command identifier for tracking and killing
   * @param lockOptions - Lock behavior options
   * @param lockOptions.background - If true, release lock after 'start' event (for startProcess).
   *                                 If false (default), hold lock until streaming completes (for exec --stream).
   * @returns A promise that resolves when first event is processed, with continueStreaming promise for background execution
   */
  async executeStreamInSession(
    sessionId: string,
    command: string,
    onEvent: (event: ExecEvent) => Promise<void>,
    options: { cwd?: string; env?: Record<string, string | undefined> } = {},
    commandId: string,
    lockOptions: { background?: boolean } = {}
  ): Promise<ServiceResult<{ continueStreaming: Promise<void> }>> {
    const { background = false } = lockOptions;
    const lock = this.getSessionLock(sessionId);

    // For background mode: acquire lock, process start event, release lock, continue streaming
    // For foreground mode: acquire lock, process all events, release lock
    if (background) {
      return this.executeStreamBackground(
        sessionId,
        command,
        onEvent,
        options,
        commandId,
        lock
      );
    } else {
      return this.executeStreamForeground(
        sessionId,
        command,
        onEvent,
        options,
        commandId,
        lock
      );
    }
  }

  /**
   * Foreground streaming: hold lock until all events are processed
   */
  private async executeStreamForeground(
    sessionId: string,
    command: string,
    onEvent: (event: ExecEvent) => Promise<void>,
    options: { cwd?: string; env?: Record<string, string | undefined> },
    commandId: string,
    lock: Mutex
  ): Promise<ServiceResult<{ continueStreaming: Promise<void> }>> {
    return lock.runExclusive(async () => {
      try {
        const { cwd, env } = options;

        const sessionResult = await this.getOrCreateSession(sessionId, {
          cwd: cwd || '/workspace'
        });

        if (!sessionResult.success) {
          return sessionResult as ServiceResult<{
            continueStreaming: Promise<void>;
          }>;
        }

        const session = sessionResult.data;
        const generator = session.execStream(command, { commandId, cwd, env });

        // Process ALL events under lock
        for await (const event of generator) {
          await onEvent(event);
        }

        return {
          success: true,
          data: { continueStreaming: Promise.resolve() }
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          'Failed to execute streaming command',
          error instanceof Error ? error : undefined,
          {
            sessionId,
            command
          }
        );

        return {
          success: false,
          error: {
            message: `Failed to execute streaming command '${command}' in session '${sessionId}': ${errorMessage}`,
            code: ErrorCode.STREAM_START_ERROR,
            details: {
              command,
              stderr: errorMessage
            } satisfies CommandErrorContext
          }
        };
      }
    });
  }

  /**
   * Background streaming: hold lock only until 'start' event, then release.
   *
   * This mode is used for long-running background processes (like servers)
   * where we want to:
   * 1. Ensure the process starts successfully (verified by 'start' event)
   * 2. Allow other commands to run while the background process continues
   *
   * IMPORTANT SAFETY NOTE: After lock release, session state (cwd, env vars)
   * may change while the background process is running. This is intentional -
   * background processes capture their environment at start time and are not
   * affected by subsequent session state changes. The process runs in its own
   * shell context independent of the session's interactive state.
   *
   * Use cases:
   * - Starting web servers (python -m http.server, node server.js)
   * - Starting background services
   * - Any long-running process that should not block other operations
   */
  private async executeStreamBackground(
    sessionId: string,
    command: string,
    onEvent: (event: ExecEvent) => Promise<void>,
    options: { cwd?: string; env?: Record<string, string | undefined> },
    commandId: string,
    lock: Mutex
  ): Promise<ServiceResult<{ continueStreaming: Promise<void> }>> {
    // Acquire lock for startup phase only
    const startupResult = await lock.runExclusive(async () => {
      try {
        const { cwd, env } = options;

        const sessionResult = await this.getOrCreateSession(sessionId, {
          cwd: cwd || '/workspace'
        });

        if (!sessionResult.success) {
          return { success: false as const, error: sessionResult.error };
        }

        const session = sessionResult.data;
        const generator = session.execStream(command, { commandId, cwd, env });

        // Process 'start' event under lock
        const firstResult = await generator.next();

        if (firstResult.done) {
          return {
            success: true as const,
            generator: null,
            firstEvent: null
          };
        }

        await onEvent(firstResult.value);

        // If already complete/error, drain remaining events under lock
        if (
          firstResult.value.type === 'complete' ||
          firstResult.value.type === 'error'
        ) {
          for await (const event of generator) {
            await onEvent(event);
          }
          return {
            success: true as const,
            generator: null,
            firstEvent: null
          };
        }

        // Return generator for background processing (lock will be released)
        return {
          success: true as const,
          generator,
          firstEvent: firstResult.value
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          'Failed to start streaming command',
          error instanceof Error ? error : undefined,
          {
            sessionId,
            command
          }
        );

        return {
          success: false as const,
          error: {
            message: `Failed to execute streaming command '${command}' in session '${sessionId}': ${errorMessage}`,
            code: ErrorCode.STREAM_START_ERROR,
            details: {
              command,
              stderr: errorMessage
            } satisfies CommandErrorContext
          }
        };
      }
    });

    if (!startupResult.success) {
      return {
        success: false,
        error: startupResult.error!
      };
    }

    // If generator is null, everything completed during startup
    if (!startupResult.generator) {
      return {
        success: true,
        data: { continueStreaming: Promise.resolve() }
      };
    }

    // Continue streaming remaining events WITHOUT lock
    const continueStreaming = (async () => {
      try {
        for await (const event of startupResult.generator!) {
          await onEvent(event);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          'Error during background streaming',
          error instanceof Error ? error : undefined,
          {
            sessionId,
            commandId,
            originalError: errorMessage
          }
        );
        throw error;
      }
    })();

    return {
      success: true,
      data: { continueStreaming }
    };
  }

  /**
   * Kill a running command in a session.
   * Does not acquire session lock - kill signals must work immediately,
   * even while another command is queued or running.
   */
  async killCommand(
    sessionId: string,
    commandId: string
  ): Promise<ServiceResult<void>> {
    try {
      const sessionResult = await this.getSession(sessionId);

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<void>;
      }

      const session = sessionResult.data;

      const killed = await session.killCommand(commandId);

      if (!killed) {
        return {
          success: false,
          error: {
            message: `Command '${commandId}' not found or already completed in session '${sessionId}'`,
            code: ErrorCode.COMMAND_NOT_FOUND,
            details: {
              command: commandId
            } satisfies CommandNotFoundContext
          }
        };
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to kill command',
        error instanceof Error ? error : undefined,
        {
          sessionId,
          commandId
        }
      );

      return {
        success: false,
        error: {
          message: `Failed to kill command '${commandId}' in session '${sessionId}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: commandId,
            stderr: errorMessage
          }
        }
      };
    }
  }

  /**
   * Set environment variables on a session atomically.
   * All exports/unsets are executed under a single lock acquisition.
   * - String values are exported
   * - undefined/null values are unset
   */
  async setEnvVars(
    sessionId: string,
    envVars: Record<string, string | undefined>
  ): Promise<ServiceResult<void>> {
    const { toSet, toUnset } = partitionEnvVars(envVars);

    return this.withSession(sessionId, async (exec) => {
      // Validate all keys first (POSIX portable character set)
      const allKeys = [...toUnset, ...Object.keys(toSet)];
      for (const key of allKeys) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw {
            code: ErrorCode.VALIDATION_FAILED,
            message: `Invalid environment variable name: ${key}`,
            details: { key }
          };
        }
      }

      for (const key of toUnset) {
        const unsetCommand = `unset ${key}`;
        const result = await exec(unsetCommand);

        if (result.exitCode !== 0) {
          throw {
            code: ErrorCode.COMMAND_EXECUTION_ERROR,
            message: `Failed to unset environment variable '${key}': ${result.stderr}`,
            details: {
              command: unsetCommand,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies CommandErrorContext
          };
        }
      }

      for (const [key, value] of Object.entries(toSet)) {
        const exportCommand = `export ${key}=${shellEscape(value)}`;
        const result = await exec(exportCommand);

        if (result.exitCode !== 0) {
          throw {
            code: ErrorCode.COMMAND_EXECUTION_ERROR,
            message: `Failed to set environment variable '${key}': ${result.stderr}`,
            details: {
              command: exportCommand,
              exitCode: result.exitCode,
              stderr: result.stderr
            } satisfies CommandErrorContext
          };
        }
      }
    });
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<ServiceResult<void>> {
    try {
      const session = this.sessions.get(sessionId);

      if (!session) {
        return {
          success: false,
          error: {
            message: `Session '${sessionId}' not found`,
            code: ErrorCode.INTERNAL_ERROR,
            details: {
              sessionId,
              originalError: 'Session not found'
            } satisfies InternalErrorContext
          }
        };
      }

      await session.destroy();
      this.sessions.delete(sessionId);
      this.sessionLocks.delete(sessionId);
      this.creatingLocks.delete(sessionId);

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to delete session',
        error instanceof Error ? error : undefined,
        {
          sessionId
        }
      );

      return {
        success: false,
        error: {
          message: `Failed to delete session '${sessionId}': ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            sessionId,
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<ServiceResult<string[]>> {
    try {
      const sessionIds = Array.from(this.sessions.keys());

      return {
        success: true,
        data: sessionIds
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to list sessions',
        error instanceof Error ? error : undefined
      );

      return {
        success: false,
        error: {
          message: `Failed to list sessions: ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * Cleanup method for graceful shutdown
   */
  async destroy(): Promise<void> {
    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        await session.destroy();
      } catch (error) {
        this.logger.error(
          'Failed to destroy session',
          error instanceof Error ? error : undefined,
          {
            sessionId
          }
        );
      }
    }

    this.sessions.clear();
    this.sessionLocks.clear();
    this.creatingLocks.clear();
  }
}
