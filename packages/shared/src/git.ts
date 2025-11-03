import type { LogContext, Logger } from './logger';

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
  try {
    // Use URL parsing for correct handling of credentials
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '******';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    // Not a valid URL, fall back to string operations
    const protocolEnd = url.indexOf('://');
    if (protocolEnd === -1) return url;

    const atIndex = url.indexOf('@', protocolEnd + 3);
    if (atIndex === -1) return url;

    return `${url.substring(0, protocolEnd + 3)}******${url.substring(atIndex)}`;
  }
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
        result[key] =
          typeof value === 'string' ? redactCredentials(value) : value;
      } else if (
        key === 'stderr' ||
        key === 'errorMessage' ||
        key === 'message'
      ) {
        result[key] =
          typeof value === 'string' ? redactCredentials(value) : value;
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
