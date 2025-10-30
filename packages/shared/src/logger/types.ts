/**
 * Logger types for Cloudflare Sandbox SDK
 *
 * Provides structured, trace-aware logging across Worker, Durable Object, and Container.
 */

/**
 * Log levels (from most to least verbose)
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export type LogComponent = 'container' | 'sandbox-do' | 'executor';

/**
 * Context metadata included in every log entry
 */
export interface LogContext {
  /**
   * Unique trace ID for request correlation across distributed components
   * Format: "tr_" + 16 hex chars (e.g., "tr_7f3a9b2c4e5d6f1a")
   */
  traceId: string;

  /**
   * Component that generated the log
   */
  component: LogComponent;

  /**
   * Sandbox identifier (which sandbox instance)
   */
  sandboxId?: string;

  /**
   * Session identifier (which session within sandbox)
   */
  sessionId?: string;

  /**
   * Process identifier (which background process)
   */
  processId?: string;

  /**
   * Command identifier (which command execution)
   */
  commandId?: string;

  /**
   * Operation name (e.g., 'exec', 'startProcess', 'writeFile')
   */
  operation?: string;

  /**
   * Duration in milliseconds
   */
  duration?: number;

  /**
   * Extensible for additional metadata
   */
  [key: string]: unknown;
}

/**
 * Logger interface for structured logging
 *
 * All methods accept optional context that gets merged with the logger's base context.
 */
export interface Logger {
  /**
   * Log debug-level message (most verbose, typically disabled in production)
   *
   * @param message Human-readable message
   * @param context Optional additional context
   */
  debug(message: string, context?: Partial<LogContext>): void;

  /**
   * Log info-level message (normal operational events)
   *
   * @param message Human-readable message
   * @param context Optional additional context
   */
  info(message: string, context?: Partial<LogContext>): void;

  /**
   * Log warning-level message (recoverable issues, degraded state)
   *
   * @param message Human-readable message
   * @param context Optional additional context
   */
  warn(message: string, context?: Partial<LogContext>): void;

  /**
   * Log error-level message (failures, exceptions)
   *
   * @param message Human-readable message
   * @param error Optional Error object to include
   * @param context Optional additional context
   */
  error(message: string, error?: Error, context?: Partial<LogContext>): void;

  /**
   * Create a child logger with additional context
   *
   * The child logger inherits all context from the parent and adds new context.
   * This is useful for adding operation-specific context without passing through parameters.
   *
   * @param context Additional context to merge
   * @returns New logger instance with merged context
   *
   * @example
   * const logger = createLogger({ component: 'sandbox-do', traceId: 'tr_abc123' });
   * const execLogger = logger.child({ operation: 'exec', commandId: 'cmd-456' });
   * execLogger.info('Command started'); // Includes all context: component, traceId, operation, commandId
   */
  child(context: Partial<LogContext>): Logger;
}
