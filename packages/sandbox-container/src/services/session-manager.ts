// SessionManager Service - Manages persistent execution sessions

import type { ExecEvent, Logger } from '@repo/shared';
import type {
  CommandErrorContext,
  CommandNotFoundContext,
  InternalErrorContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type { ServiceResult } from '../core/types';
import { type RawExecResult, Session, type SessionOptions } from '../session';

/**
 * SessionManager manages persistent execution sessions.
 * Wraps the session.ts Session class with ServiceResult<T> pattern.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private logger: Logger) {}

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
            code: ErrorCode.INTERNAL_ERROR,
            details: {
              sessionId: options.id,
              originalError: 'Session already exists'
            } satisfies InternalErrorContext
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
   * Execute a command in a session
   */
  async executeInSession(
    sessionId: string,
    command: string,
    cwd?: string,
    timeoutMs?: number,
    env?: Record<string, string>
  ): Promise<ServiceResult<RawExecResult>> {
    try {
      // Get or create session on demand
      let sessionResult = await this.getSession(sessionId);

      // If session doesn't exist, create it automatically
      if (
        !sessionResult.success &&
        (sessionResult.error!.details as InternalErrorContext)
          ?.originalError === 'Session not found'
      ) {
        sessionResult = await this.createSession({
          id: sessionId,
          cwd: cwd || '/workspace',
          commandTimeoutMs: timeoutMs // Pass timeout to session
        });
      }

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
  }

  /**
   * Execute a command with streaming output
   *
   * @param sessionId - The session identifier
   * @param command - The command to execute
   * @param onEvent - Callback for streaming events
   * @param cwd - Optional working directory override
   * @param commandId - Required command identifier for tracking and killing
   * @returns A promise that resolves when first event is processed, with continueStreaming promise for background execution
   */
  async executeStreamInSession(
    sessionId: string,
    command: string,
    onEvent: (event: ExecEvent) => Promise<void>,
    options: { cwd?: string; env?: Record<string, string> } = {},
    commandId: string
  ): Promise<ServiceResult<{ continueStreaming: Promise<void> }>> {
    try {
      const { cwd, env } = options;

      // Get or create session on demand
      let sessionResult = await this.getSession(sessionId);

      // If session doesn't exist, create it automatically
      if (
        !sessionResult.success &&
        (sessionResult.error!.details as InternalErrorContext)
          ?.originalError === 'Session not found'
      ) {
        sessionResult = await this.createSession({
          id: sessionId,
          cwd: cwd || '/workspace'
        });
      }

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<{
          continueStreaming: Promise<void>;
        }>;
      }

      const session = sessionResult.data;

      const generator = session.execStream(command, { commandId, cwd, env });

      /*
       * EVENT DRAINING STRATEGY
       *
       * We process the first 2 events synchronously before returning. Why 2?
       *
       * Event sequence for commands:
       *   Fast command (echo 123):  start → stdout → complete
       *   No-output command (true): start → complete
       *   Long-running (sleep 10):  start → ... (events trickle in over time)
       *
       * - Event 1 is always 'start' (with PID) - must await to track the command
       * - Event 2 is typically 'stdout' (first output) or 'complete' (no output)
       *
       * By processing 2 events, getLogs() returns correct data for fast commands
       * like "echo 123" without blocking long-running commands unnecessarily.
       * This is a heuristic - commands with multiple stdout chunks may have
       * partial output if getLogs() is called immediately after startProcess().
       */

      const firstResult = await generator.next();

      if (firstResult.done) {
        return {
          success: true,
          data: { continueStreaming: Promise.resolve() }
        };
      }

      await onEvent(firstResult.value);

      if (
        firstResult.value.type === 'complete' ||
        firstResult.value.type === 'error'
      ) {
        for await (const event of generator) {
          await onEvent(event);
        }
        return {
          success: true,
          data: { continueStreaming: Promise.resolve() }
        };
      }

      const secondResult = await generator.next();

      if (secondResult.done) {
        return {
          success: true,
          data: { continueStreaming: Promise.resolve() }
        };
      }

      await onEvent(secondResult.value);

      if (
        secondResult.value.type === 'complete' ||
        secondResult.value.type === 'error'
      ) {
        for await (const event of generator) {
          await onEvent(event);
        }
        return {
          success: true,
          data: { continueStreaming: Promise.resolve() }
        };
      }

      // Process still running after 2 events - continue in background
      const continueStreaming = (async () => {
        try {
          for await (const event of generator) {
            await onEvent(event);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          this.logger.error(
            'Error during streaming',
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
  }

  /**
   * Kill a running command in a session
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
   * Set environment variables on a session
   */
  async setEnvVars(
    sessionId: string,
    envVars: Record<string, string>
  ): Promise<ServiceResult<void>> {
    try {
      // Get or create session on demand
      let sessionResult = await this.getSession(sessionId);

      // If session doesn't exist, create it automatically
      if (
        !sessionResult.success &&
        (sessionResult.error!.details as InternalErrorContext)
          ?.originalError === 'Session not found'
      ) {
        sessionResult = await this.createSession({
          id: sessionId,
          cwd: '/workspace'
        });
      }

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<void>;
      }

      const session = sessionResult.data;

      // Export each environment variable in the running bash session
      for (const [key, value] of Object.entries(envVars)) {
        // Escape the value for safe bash usage
        const escapedValue = value.replace(/'/g, "'\\''");
        const exportCommand = `export ${key}='${escapedValue}'`;

        const result = await session.exec(exportCommand);

        if (result.exitCode !== 0) {
          return {
            success: false,
            error: {
              message: `Failed to set environment variable '${key}' in session '${sessionId}': ${result.stderr}`,
              code: ErrorCode.COMMAND_EXECUTION_ERROR,
              details: {
                command: `export ${key}='...'`,
                exitCode: result.exitCode,
                stderr: result.stderr
              } satisfies CommandErrorContext
            }
          };
        }
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to set environment variables',
        error instanceof Error ? error : undefined,
        { sessionId }
      );

      return {
        success: false,
        error: {
          message: `Failed to set environment variables in session '${sessionId}': ${errorMessage}`,
          code: ErrorCode.COMMAND_EXECUTION_ERROR,
          details: {
            command: 'export',
            stderr: errorMessage
          } satisfies CommandErrorContext
        }
      };
    }
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
  }
}
