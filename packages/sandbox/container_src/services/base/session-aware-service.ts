// Generic Session-Aware Base Service Class
// Provides ONLY session execution utilities - no domain-specific methods

import type { Logger, ServiceResult } from '../../core/types';
import type { SessionManager, Session } from '../../isolation';

export abstract class SessionAwareService {
  protected sessionManager: SessionManager;
  protected logger: Logger;

  constructor(sessionManager: SessionManager, logger: Logger) {
    this.sessionManager = sessionManager;
    this.logger = logger;
  }

  /**
   * Execute a command in a session - GENERIC utility method with dual-mode support
   * Services build their own domain-specific commands and use this for execution
   * @param command - Shell command to execute
   * @param sessionId - Session ID to execute command in (optional - uses default if not provided)
   * @param options - Execution options
   */
  protected async executeInSession(command: string, sessionId?: string, options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    isolation?: boolean;
  } = {}): Promise<ServiceResult<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>> {
    try {
      // Dual-mode pattern: use specific session if provided, otherwise default session
      let session: Session;
      if (sessionId) {
        const specificSession = this.sessionManager.getSession(sessionId);
        if (!specificSession) {
          return {
            success: false,
            error: {
              message: `Session '${sessionId}' not found`,
              code: 'SESSION_NOT_FOUND',
              details: { sessionId, command },
            },
          };
        }
        session = specificSession;
      } else {
        // Use default session (auto-creates if needed)
        session = await this.sessionManager.getOrCreateDefaultSession();
      }
      
      const result = await session.exec(command, options);
      
      // Convert session result format → ServiceResult format
      return {
        success: true, // ServiceResult success = operation completed, not command success
        data: {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: {
          message: 'Session command execution failed',
          code: 'SESSION_EXEC_ERROR',
          details: { command, originalError: errorMessage, options },
        },
      };
    }
  }

  /**
   * Template method for common validation patterns
   * Subclasses can override to add domain-specific validation
   */
  protected validateInput(input: unknown, operation: string): ServiceResult<void> {
    if (input === null || input === undefined) {
      return {
        success: false,
        error: {
          message: `Invalid input for ${operation}`,
          code: 'INVALID_INPUT',
          details: { operation, input },
        },
      };
    }

    return { success: true };
  }

}