import type { ErrorCode } from './codes';

/**
 * Standard operation types
 */
export const Operation = {
  // File Operations
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  FILE_DELETE: 'file.delete',
  FILE_MOVE: 'file.move',
  FILE_RENAME: 'file.rename',
  FILE_STAT: 'file.stat',
  DIRECTORY_CREATE: 'directory.create',
  DIRECTORY_LIST: 'directory.list',

  // Command Operations
  COMMAND_EXECUTE: 'command.execute',
  COMMAND_STREAM: 'command.stream',

  // Process Operations
  PROCESS_START: 'process.start',
  PROCESS_KILL: 'process.kill',
  PROCESS_LIST: 'process.list',
  PROCESS_GET: 'process.get',
  PROCESS_LOGS: 'process.logs',

  // Port Operations
  PORT_EXPOSE: 'port.expose',
  PORT_UNEXPOSE: 'port.unexpose',
  PORT_LIST: 'port.list',
  PORT_PROXY: 'port.proxy',

  // Git Operations
  GIT_CLONE: 'git.clone',
  GIT_CHECKOUT: 'git.checkout',
  GIT_OPERATION: 'git.operation',

  // Backup Operations
  BACKUP_CREATE: 'backup.create',
  BACKUP_RESTORE: 'backup.restore',
  BACKUP_UNMOUNT: 'backup.unmount',

  // Code Interpreter
  CODE_EXECUTE: 'code.execute',
  CODE_CONTEXT_CREATE: 'code.context.create',
  CODE_CONTEXT_DELETE: 'code.context.delete'
} as const;

export type OperationType = (typeof Operation)[keyof typeof Operation];

/**
 * Standard error response format with generic context type
 * TContext allows type-safe access to error-specific context
 */
export interface ErrorResponse<TContext = Record<string, unknown>> {
  /**
   * Error type code (machine-readable)
   */
  code: ErrorCode;

  /**
   * Human-readable error message
   */
  message: string;

  /**
   * Operation that was attempted (useful for debugging and logging)
   */
  operation?: OperationType;

  /**
   * Structured error context with relevant details
   * Type varies based on error code
   */
  context: TContext;

  /**
   * HTTP status code (for client SDK)
   */
  httpStatus: number;

  /**
   * Timestamp when error occurred
   */
  timestamp: string;

  /**
   * Actionable suggestion for fixing the error
   */
  suggestion?: string;

  /**
   * Link to documentation
   */
  documentation?: string;
}

/**
 * Container ServiceError (lightweight, enriched by handlers)
 */
export interface ServiceError {
  message: string;
  code: ErrorCode;
  details?: Record<string, unknown>; // Becomes context in ErrorResponse
}

/**
 * ServiceResult type for container services
 */
export type ServiceResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: ServiceError;
    };
