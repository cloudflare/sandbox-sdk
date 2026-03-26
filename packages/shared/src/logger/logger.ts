/**
 * Logger implementation
 */

import type { LogContext, Logger, LogLevel } from './types.js';
import { LogLevel as LogLevelEnum } from './types.js';

/**
 * Output mode for log entries:
 * - 'pretty'     — ANSI-colored single-line string (local dev)
 * - 'structured' — raw object passed to console (Workers/DOs — auto-indexed by Workers Logs)
 * - 'json-line'  — JSON.stringify string (container stdout — parsed by Containers pipeline)
 */
export type OutputMode = 'pretty' | 'structured' | 'json-line';

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
   * @param outputMode How log entries are formatted and emitted (default: 'structured')
   */
  constructor(
    private readonly baseContext: LogContext,
    private readonly minLevel: LogLevel = LogLevelEnum.INFO,
    private readonly outputMode: OutputMode = 'structured'
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
      this.outputMode
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
      message,
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
   * Output log data using the configured output mode
   */
  private output(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    switch (this.outputMode) {
      case 'pretty':
        this.outputPretty(consoleFn, data);
        break;
      case 'json-line':
        this.outputJsonLine(consoleFn, data);
        break;
      case 'structured':
        this.outputStructured(consoleFn, data);
        break;
    }
  }

  /**
   * Output as JSON string (container stdout — parsed by Containers pipeline)
   */
  private outputJsonLine(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    consoleFn(JSON.stringify(data));
  }

  /**
   * Output as raw object (Workers/DOs — Workers Logs auto-indexes fields)
   */
  private outputStructured(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    consoleFn(data);
  }

  /**
   * Output as pretty-printed, colored text (development)
   *
   * Each log event is a single consoleFn() call so it appears as one entry
   * in the Cloudflare dashboard. Context is rendered inline as compact key=value pairs.
   *
   * Format: LEVEL [component] message trace=tr_... key=value key=value
   */
  private outputPretty(
    consoleFn: typeof console.log | typeof console.warn | typeof console.error,
    data: Record<string, unknown>
  ): void {
    const {
      level,
      message: msg,
      timestamp,
      traceId,
      component,
      sandboxId,
      sessionId,
      processId,
      commandId,
      durationMs,
      serviceVersion,
      instanceId,
      error,
      ...rest
    } = data;

    const levelStr = String(level || 'INFO').toUpperCase();
    const levelColor = this.getLevelColor(levelStr);
    const componentBadge = component ? `[${component}]` : '';

    const timeStr = timestamp
      ? `${COLORS.dim}${new Date(timestamp as string).toISOString().substring(11, 23)}${COLORS.reset} `
      : '';

    let logLine = `${timeStr}${levelColor}${levelStr.padEnd(5)}${COLORS.reset} ${componentBadge} ${msg}`;

    // Append all context as compact key=value pairs on the same line
    const pairs: string[] = [];
    if (traceId) pairs.push(`trace=${String(traceId).substring(0, 12)}`);
    if (commandId) pairs.push(`cmd=${String(commandId).substring(0, 12)}`);
    if (sandboxId) pairs.push(`sandbox=${sandboxId}`);
    if (sessionId) pairs.push(`session=${String(sessionId).substring(0, 12)}`);
    if (processId) pairs.push(`proc=${processId}`);
    if (durationMs !== undefined) pairs.push(`dur=${durationMs}ms`);

    // Append remaining context fields inline
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null) continue;
      const v =
        typeof value === 'object'
          ? JSON.stringify(value)
          : this.sanitizePrettyValue(String(value));
      pairs.push(`${key}=${v}`);
    }

    // Append error info inline
    if (error && typeof error === 'object') {
      const errorObj = error as {
        message?: string;
        stack?: string;
        name?: string;
      };
      if (errorObj.name)
        pairs.push(`err.name=${this.sanitizePrettyValue(errorObj.name)}`);
      if (errorObj.message)
        pairs.push(`err.msg=${this.sanitizePrettyValue(errorObj.message)}`);
      if (errorObj.stack)
        pairs.push(`err.stack=${this.sanitizePrettyValue(errorObj.stack)}`);
    }

    if (pairs.length > 0) {
      logLine += ` ${COLORS.dim}${pairs.join(' ')}${COLORS.reset}`;
    }

    // Single consoleFn call = single log entry in the dashboard
    consoleFn(logLine);
  }

  /**
   * Collapse newlines so a single consoleFn() call stays on one line.
   * Cloudflare's log pipeline splits on literal newlines, which fragments
   * stack traces and multi-line error messages into separate entries.
   */
  private sanitizePrettyValue(value: string): string {
    return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
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
