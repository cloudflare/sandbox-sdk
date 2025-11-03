import type { LogContext, Logger } from "./logger";

/**
 * Redact credentials from URLs for secure logging
 *
 * Replaces any credentials (username:password, tokens, etc.) embedded
 * in URLs with ****** to prevent sensitive data exposure in logs.
 *
 * @param url - The URL that may contain credentials
 * @returns URL with credentials redacted
 */
export function redactCredentials(url: string): string {
  // Replace any credentials between :// and @ with ******
  return url.replace(/:\/\/[^@]+@/g, '://******@');
}

/**
 * Sanitize git-specific data by redacting credentials from known fields
 * Recursively processes objects to ensure credentials are never leaked in logs or errors
 */
export function sanitizeGitData<T>(data: T): T {
  // Handle primitives
  if (typeof data === 'string') {
    return redactCredentials(data) as T;
  }

  if (data === null || data === undefined) {
    return data;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeGitData(item)) as T;
  }

  // Handle objects
  if (typeof data === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(data)) {
      // Field-specific redaction rules
      if (key === 'repoUrl' || key === 'repository') {
        result[key] = typeof value === 'string' ? redactCredentials(value) : value;
      } else if (
        key === 'stderr' ||
        key === 'errorMessage' ||
        key === 'message'
      ) {
        result[key] = typeof value === 'string' ? redactCredentials(value) : value;
      } else {
        // Recursively sanitize nested objects
        result[key] = sanitizeGitData(value);
      }
    }
    return result as T;
  }

  return data;
}

/**
 * Logger wrapper that automatically sanitizes git credentials
 */
export class GitLogger implements Logger {
  constructor(private readonly baseLogger: Logger) {}

  debug(message: string, context?: Partial<LogContext>): void {
    const sanitized = context
      ? (sanitizeGitData(context) as Partial<LogContext>)
      : context;
    this.baseLogger.debug(message, sanitized);
  }

  info(message: string, context?: Partial<LogContext>): void {
    const sanitized = context
      ? (sanitizeGitData(context) as Partial<LogContext>)
      : context;
    this.baseLogger.info(message, sanitized);
  }

  warn(message: string, context?: Partial<LogContext>): void {
    const sanitized = context
      ? (sanitizeGitData(context) as Partial<LogContext>)
      : context;
    this.baseLogger.warn(message, sanitized);
  }

  error(message: string, error?: Error, context?: Partial<LogContext>): void {
    const sanitized = context
      ? (sanitizeGitData(context) as Partial<LogContext>)
      : context;
    this.baseLogger.error(message, error, sanitized);
  }

  child(context: Partial<LogContext>): Logger {
    // Create child from base logger, then wrap it
    const childLogger = this.baseLogger.child(context);
    return new GitLogger(childLogger);
  }
}
