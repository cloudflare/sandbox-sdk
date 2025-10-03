// SessionManager Service - Manages isolated execution sessions
import type { Logger, ServiceResult } from '../core/types';
import { Session, type SessionOptions, type RawExecResult } from '../isolation';
import type { ExecEvent } from '@repo/shared-types';

/**
 * SessionManager manages isolated execution sessions.
 * Wraps the isolation.ts Session class with ServiceResult<T> pattern.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private defaultSessionId = 'default';

  constructor(private logger: Logger) {
    this.logger.info('SessionManager initialized');
  }

  /**
   * Get or create the default session for this sandbox
   */
  async getDefaultSession(): Promise<ServiceResult<Session>> {
    const existing = this.sessions.get(this.defaultSessionId);
    if (existing) {
      return {
        success: true,
        data: existing,
      };
    }

    return await this.createSession({
      id: this.defaultSessionId,
      cwd: '/workspace',
      isolation: true,
    });
  }

  /**
   * Create a new isolated session
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

      // In test environment (NODE_ENV=test), disable isolation to avoid control process overhead
      const isTest = process.env.NODE_ENV === 'test';
      const sessionOptions = {
        ...options,
        isolation: isTest ? false : options.isolation,
      };

      // Create and initialize session
      const session = new Session(sessionOptions);
      await session.initialize();

      this.sessions.set(options.id, session);

      this.logger.info('Session created successfully', {
        sessionId: options.id,
        isolation: sessionOptions.isolation
      });

      return {
        success: true,
        data: session,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create session', error instanceof Error ? error : undefined, {
        sessionId: options.id,
      });

      return {
        success: false,
        error: {
          message: 'Failed to create session',
          code: 'SESSION_CREATE_ERROR',
          details: { sessionId: options.id, originalError: errorMessage },
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
          isolation: true,
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
   */
  async executeStreamInSession(
    sessionId: string,
    command: string,
    onEvent: (event: ExecEvent) => void,
    cwd?: string
  ): Promise<ServiceResult<void>> {
    try {
      // Get or create session on demand
      let sessionResult = await this.getSession(sessionId);

      // If session doesn't exist, create it automatically
      if (!sessionResult.success && sessionResult.error!.code === 'SESSION_NOT_FOUND') {
        sessionResult = await this.createSession({
          id: sessionId,
          cwd: cwd || '/workspace',
          isolation: true,
        });
      }

      if (!sessionResult.success) {
        return sessionResult as ServiceResult<void>;
      }

      const session = sessionResult.data;

      this.logger.info('Executing streaming command in session', { sessionId, command, cwd });

      for await (const event of session.execStream(command, cwd ? { cwd } : undefined)) {
        onEvent(event);
      }

      this.logger.info('Streaming command completed', { sessionId });

      return {
        success: true,
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
