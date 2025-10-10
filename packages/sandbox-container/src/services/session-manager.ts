// SessionManager Service - Manages persistent execution sessions

import type { ExecEvent } from '@repo/shared-types';
import type { Logger, ServiceResult } from '../core/types';
import { type RawExecResult, Session, type SessionOptions } from '../session';

/**
 * SessionManager manages persistent execution sessions.
 * Wraps the session.ts Session class with ServiceResult<T> pattern.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private logger: Logger) {
    this.logger.info('SessionManager initialized');
  }

  /**
   * Create a new persistent session
   */
  async createSession(options: SessionOptions): Promise<ServiceResult<Session>> {
    try {
      this.logger.info('Creating session', { sessionId: options.id });

      // Check if session already exists
      if (this.sessions.has(options.id)) {
        return {
          success: false,
          error: {
            message: `Session '${options.id}' already exists`,
            code: 'SESSION_EXISTS',
            details: { sessionId: options.id },
          },
        };
      }

      // Create and initialize session
      console.log('[SessionManager] Creating Session object', { sessionId: options.id, options });
      const session = new Session(options);
      console.log('[SessionManager] Session object created, calling initialize()');
      await session.initialize();
      console.log('[SessionManager] Session initialized successfully');

      this.sessions.set(options.id, session);

      this.logger.info('Session created successfully', {
        sessionId: options.id,
        cwd: options.cwd
      });

      return {
        success: true,
        data: session,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      console.error('[SessionManager] Session creation failed:', {
        sessionId: options.id,
        error: errorMessage,
        stack: errorStack,
      });

      this.logger.error('Failed to create session', error instanceof Error ? error : undefined, {
        sessionId: options.id,
        originalError: errorMessage,
      });

      return {
        success: false,
        error: {
          message: `Failed to create session: ${errorMessage}`,
          code: 'SESSION_CREATE_ERROR',
          details: { sessionId: options.id, originalError: errorMessage, stack: errorStack },
        },
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
          code: 'SESSION_NOT_FOUND',
          details: { sessionId },
        },
      };
    }

    return {
      success: true,
      data: session,
    };
  }

  /**
   * Execute a command in a session
   */
  async executeInSession(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<ServiceResult<RawExecResult>> {
    try {
      // Get or create session on demand
      let sessionResult = await this.getSession(sessionId);

      // If session doesn't exist, create it automatically
      if (!sessionResult.success && sessionResult.error!.code === 'SESSION_NOT_FOUND') {
        sessionResult = await this.createSession({
          id: sessionId,
          cwd: cwd || '/workspace',
        });
      }

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<RawExecResult>;
      }

      const session = sessionResult.data;

      this.logger.info('Executing command in session', { sessionId, command, cwd });

      const result = await session.exec(command, cwd ? { cwd } : undefined);

      this.logger.info('Command executed successfully', {
        sessionId,
        exitCode: result.exitCode,
      });

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to execute command', error instanceof Error ? error : undefined, {
        sessionId,
        command,
      });

      return {
        success: false,
        error: {
          message: 'Failed to execute command in session',
          code: 'SESSION_EXEC_ERROR',
          details: { sessionId, command, originalError: errorMessage },
        },
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
    onEvent: (event: ExecEvent) => void,
    cwd: string | undefined,
    commandId: string
  ): Promise<ServiceResult<{ continueStreaming: Promise<void> }>> {
    try {
      // Get or create session on demand
      let sessionResult = await this.getSession(sessionId);

      // If session doesn't exist, create it automatically
      if (!sessionResult.success && sessionResult.error!.code === 'SESSION_NOT_FOUND') {
        sessionResult = await this.createSession({
          id: sessionId,
          cwd: cwd || '/workspace',
        });
      }

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<{ continueStreaming: Promise<void> }>;
      }

      const session = sessionResult.data;

      this.logger.info('Executing streaming command in session', { sessionId, command, cwd, commandId });

      // Get async generator
      const generator = session.execStream(command, { commandId, cwd });

      console.log(`[SessionManager] Awaiting first event for commandId: ${commandId}`);

      // CRITICAL: Await first event to ensure command is tracked before returning
      // This prevents race condition where killCommand() is called before trackCommand()
      const firstResult = await generator.next();

      console.log(`[SessionManager] First event received for commandId: ${commandId} | Event type: ${firstResult.done ? 'DONE' : firstResult.value.type}`);

      if (!firstResult.done) {
        onEvent(firstResult.value);
      }

      console.log(`[SessionManager] Returning from executeStreamInSession (command is now tracked): ${commandId}`);

      // Create background task for remaining events
      const continueStreaming = (async () => {
        try {
          console.log(`[SessionManager] Background streaming starting for: ${commandId}`);
          for await (const event of generator) {
            onEvent(event);
          }
          this.logger.info('Streaming command completed', { sessionId, commandId });
          console.log(`[SessionManager] Background streaming completed for: ${commandId}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.logger.error('Error during streaming', error instanceof Error ? error : undefined, {
            sessionId,
            commandId,
            originalError: errorMessage
          });
          console.log(`[SessionManager] Background streaming ERROR for: ${commandId} | Error: ${errorMessage}`);
          throw error;
        }
      })();

      return {
        success: true,
        data: { continueStreaming },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to execute streaming command', error instanceof Error ? error : undefined, {
        sessionId,
        command,
      });

      return {
        success: false,
        error: {
          message: 'Failed to execute streaming command in session',
          code: 'SESSION_EXEC_STREAM_ERROR',
          details: { sessionId, command, originalError: errorMessage },
        },
      };
    }
  }

  /**
   * Kill a running command in a session
   */
  async killCommand(sessionId: string, commandId: string): Promise<ServiceResult<void>> {
    try {
      const sessionResult = await this.getSession(sessionId);

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<void>;
      }

      const session = sessionResult.data;

      this.logger.info('Killing command in session', { sessionId, commandId });

      const killed = await session.killCommand(commandId);

      if (!killed) {
        return {
          success: false,
          error: {
            message: `Command '${commandId}' not found or already completed`,
            code: 'COMMAND_NOT_FOUND',
            details: { sessionId, commandId },
          },
        };
      }

      this.logger.info('Command killed successfully', { sessionId, commandId });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to kill command', error instanceof Error ? error : undefined, {
        sessionId,
        commandId,
      });

      return {
        success: false,
        error: {
          message: `Failed to kill command: ${errorMessage}`,
          code: 'COMMAND_KILL_ERROR',
          details: { sessionId, commandId, originalError: errorMessage },
        },
      };
    }
  }

  /**
   * Set environment variables on an existing session
   */
  async setEnvVars(sessionId: string, envVars: Record<string, string>): Promise<ServiceResult<void>> {
    try {
      const session = this.sessions.get(sessionId);

      if (!session) {
        return {
          success: false,
          error: {
            message: `Session '${sessionId}' not found`,
            code: 'SESSION_NOT_FOUND',
            details: { sessionId },
          },
        };
      }

      this.logger.info('Setting environment variables on session', { sessionId, vars: Object.keys(envVars) });

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
              message: `Failed to set environment variable ${key}: ${result.stderr}`,
              code: 'ENV_SET_ERROR',
              details: { sessionId, key, stderr: result.stderr },
            },
          };
        }
      }

      this.logger.info('Environment variables set successfully', { sessionId, count: Object.keys(envVars).length });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to set environment variables', error instanceof Error ? error : undefined, { sessionId });

      return {
        success: false,
        error: {
          message: `Failed to set environment variables: ${errorMessage}`,
          code: 'ENV_SET_ERROR',
          details: { sessionId, originalError: errorMessage },
        },
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
            code: 'SESSION_NOT_FOUND',
            details: { sessionId },
          },
        };
      }

      this.logger.info('Deleting session', { sessionId });

      await session.destroy();
      this.sessions.delete(sessionId);

      this.logger.info('Session deleted successfully', { sessionId });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to delete session', error instanceof Error ? error : undefined, {
        sessionId,
      });

      return {
        success: false,
        error: {
          message: 'Failed to delete session',
          code: 'SESSION_DELETE_ERROR',
          details: { sessionId, originalError: errorMessage },
        },
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
        data: sessionIds,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list sessions', error instanceof Error ? error : undefined);

      return {
        success: false,
        error: {
          message: 'Failed to list sessions',
          code: 'SESSION_LIST_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  /**
   * Cleanup method for graceful shutdown
   */
  async destroy(): Promise<void> {
    this.logger.info('Destroying all sessions', { count: this.sessions.size });

    for (const [sessionId, session] of this.sessions.entries()) {
      try {
        await session.destroy();
        this.logger.info('Session destroyed', { sessionId });
      } catch (error) {
        this.logger.error('Failed to destroy session', error instanceof Error ? error : undefined, {
          sessionId,
        });
      }
    }

    this.sessions.clear();
    this.logger.info('SessionManager destroyed');
  }
}
