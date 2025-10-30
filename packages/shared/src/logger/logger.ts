/**
 * Logger implementation
 */

import type { LogContext, Logger, LogLevel } from './types.js';
import { LogLevel as LogLevelEnum } from './types.js';

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
  reset: '\x1b[0m',
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
  dim: '\x1b[2m' // Dim
};

/**
 * CloudflareLogger implements structured logging with support for
 * both JSON output (production) and pretty printing (development).
 */
export class CloudflareLogger implements Logger {
  /**
   * Create a new CloudflareLogger
   *
   * @param baseContext Base context included in all log entries
   * @param minLevel Minimum log level to output (default: INFO)
   * @param pretty Enable pretty printing for human-readable output (default: false)
   */
  constructor(
    private readonly baseContext: LogContext,
    private readonly minLevel: LogLevel = LogLevelEnum.INFO,
    private readonly pretty: boolean = false
  ) {}

  /**
   * Log debug-level message
   */
  debug(message: string, context?: Partial<LogContext>): void {
    if (this.shouldLog(LogLevelEnum.DEBUG)) {
      const logData = this.buildLogData('debug', message, context);
      this.output(console.log, logData);
    }
  }

  /**
   * Log info-level message
   */
  info(message: string, context?: Partial<LogContext>): void {
    if (this.shouldLog(LogLevelEnum.INFO)) {
      const logData = this.buildLogData('info', message, context);
      this.output(console.log, logData);
    }
  }

  /**
   * Log warning-level message
   */
  warn(message: string, context?: Partial<LogContext>): void {
    if (this.shouldLog(LogLevelEnum.WARN)) {
      const logData = this.buildLogData('warn', message, context);
      this.output(console.warn, logData);
    }
  }

  /**
   * Log error-level message
   */
  error(message: string, error?: Error, context?: Partial<LogContext>): void {
    if (this.shouldLog(LogLevelEnum.ERROR)) {
      const logData = this.buildLogData('error', message, context, error);
      this.output(console.error, logData);
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(context: Partial<LogContext>): Logger {
    return new CloudflareLogger(
      { ...this.baseContext, ...context } as LogContext,
      this.minLevel,
      this.pretty
    );
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return level >= this.minLevel;
  }

  /**
   * Build log data object
   */
  private buildLogData(
    level: string,
    message: string,
    context?: Partial<LogContext>,
    error?: Error
  ): Record<string, unknown> {
    const logData: Record<string, unknown> = {
      level,
      msg: message,
      ...this.baseContext,
      ...context,
      timestamp: new Date().toISOString()
    };

    // Add error details if provided
    if (error) {
      logData.error = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    }

    return logData;
  }

  /**
   * Output log data to console (pretty or JSON)
   */
  private output(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    if (this.pretty) {
      this.outputPretty(consoleFn, data);
    } else {
      this.outputJson(consoleFn, data);
    }
  }

  /**
   * Output as JSON (production)
   */
  private outputJson(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    consoleFn(JSON.stringify(data));
  }

  /**
   * Output as pretty-printed, colored text (development)
   *
   * Format: LEVEL [component] message (trace: tr_...) {context}
   * Example: INFO [sandbox-do] Command started (trace: tr_7f3a9b2c) {commandId: "cmd-123"}
   */
  private outputPretty(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    const {
      level,
      msg,
      timestamp,
      traceId,
      component,
      sandboxId,
      sessionId,
      processId,
      commandId,
      operation,
      duration,
      error,
      ...rest
    } = data;

    // Build the main log line
    const levelStr = String(level || 'INFO').toUpperCase();
    const levelColor = this.getLevelColor(levelStr);
    const componentBadge = component ? `[${component}]` : '';
    const traceIdShort = traceId ? String(traceId).substring(0, 12) : '';

    // Start with level and component
    let logLine = `${levelColor}${levelStr.padEnd(5)}${
      COLORS.reset
    } ${componentBadge} ${msg}`;

    // Add trace ID if present
    if (traceIdShort) {
      logLine += ` ${COLORS.dim}(trace: ${traceIdShort})${COLORS.reset}`;
    }

    // Collect important context fields
    const contextFields: string[] = [];
    if (operation) contextFields.push(`operation: ${operation}`);
    if (commandId)
      contextFields.push(`commandId: ${String(commandId).substring(0, 12)}`);
    if (sandboxId) contextFields.push(`sandboxId: ${sandboxId}`);
    if (sessionId)
      contextFields.push(`sessionId: ${String(sessionId).substring(0, 12)}`);
    if (processId) contextFields.push(`processId: ${processId}`);
    if (duration !== undefined) contextFields.push(`duration: ${duration}ms`);

    // Add important context inline
    if (contextFields.length > 0) {
      logLine += ` ${COLORS.dim}{${contextFields.join(', ')}}${COLORS.reset}`;
    }

    // Output main log line
    consoleFn(logLine);

    // Output error details on separate lines if present
    if (error && typeof error === 'object') {
      const errorObj = error as {
        message?: string;
        stack?: string;
        name?: string;
      };
      if (errorObj.message) {
        consoleFn(`  ${COLORS.error}Error: ${errorObj.message}${COLORS.reset}`);
      }
      if (errorObj.stack) {
        consoleFn(`  ${COLORS.dim}${errorObj.stack}${COLORS.reset}`);
      }
    }

    // Output additional context if present
    if (Object.keys(rest).length > 0) {
      consoleFn(
        `  ${COLORS.dim}${JSON.stringify(rest, null, 2)}${COLORS.reset}`
      );
    }
  }

  /**
   * Get ANSI color code for log level
   */
  private getLevelColor(level: string): string {
    const levelLower = level.toLowerCase();
    switch (levelLower) {
      case 'debug':
        return COLORS.debug;
      case 'info':
        return COLORS.info;
      case 'warn':
        return COLORS.warn;
      case 'error':
        return COLORS.error;
      default:
        return COLORS.reset;
    }
  }
}
