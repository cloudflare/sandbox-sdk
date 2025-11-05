import type { LogContext, Logger } from './logger';

/**
 * Redact credentials from URLs for secure logging
 *
 * Replaces any credentials (username:password, tokens, etc.) embedded
 * in URLs with ****** to prevent sensitive data exposure in logs.
 * Works with URLs embedded in text (e.g., "Error: https://token@github.com/repo.git failed")
 *
 * @param text - String that may contain URLs with credentials
 * @returns String with credentials redacted from any URLs
 */
export function redactCredentials(text: string): string {
  // Pattern to match URLs with credentials (http(s):// or git@)
  // Matches: https://user:pass@host, https://token@host, git@host
  const urlPattern = /(https?:\/\/)[^:@\s]+:[^@\s]+@[^\s]+|(https?:\/\/)[^:@\s]+@[^\s]+/g;

  return text.replace(urlPattern, (match) => {
    // Check if this looks like a URL with credentials
    const protocolEnd = match.indexOf('://');
    if (protocolEnd === -1) return match;

    const atIndex = match.indexOf('@', protocolEnd + 3);
    if (atIndex === -1) return match;

    // Redact everything between protocol and @
    return `${match.substring(0, protocolEnd + 3)}******${match.substring(atIndex)}`;
  });
}

/**
 * Sanitize data by redacting credentials from any strings
 * Recursively processes objects and arrays to ensure credentials are never leaked
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

  // Handle objects - recursively sanitize all fields
  if (typeof data === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = sanitizeGitData(value);
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

  private sanitizeContext(
    context?: Partial<LogContext>
  ): Partial<LogContext> | undefined {
    return context
      ? (sanitizeGitData(context) as Partial<LogContext>)
      : context;
  }

  debug(message: string, context?: Partial<LogContext>): void {
    this.baseLogger.debug(message, this.sanitizeContext(context));
  }

  info(message: string, context?: Partial<LogContext>): void {
    this.baseLogger.info(message, this.sanitizeContext(context));
  }

  warn(message: string, context?: Partial<LogContext>): void {
    this.baseLogger.warn(message, this.sanitizeContext(context));
  }

  error(message: string, error?: Error, context?: Partial<LogContext>): void {
    this.baseLogger.error(message, error, this.sanitizeContext(context));
  }

  child(context: Partial<LogContext>): Logger {
    const sanitized = sanitizeGitData(context) as Partial<LogContext>;
    const childLogger = this.baseLogger.child(sanitized);
    return new GitLogger(childLogger);
  }
}
