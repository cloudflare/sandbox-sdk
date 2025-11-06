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
  // Scan for http(s):// URLs and redact any credentials found
  let result = text;
  let pos = 0;

  while (pos < result.length) {
    const httpPos = result.indexOf('http://', pos);
    const httpsPos = result.indexOf('https://', pos);

    let protocolPos = -1;
    let protocolLen = 0;

    if (httpPos === -1 && httpsPos === -1) break;
    if (httpPos !== -1 && (httpsPos === -1 || httpPos < httpsPos)) {
      protocolPos = httpPos;
      protocolLen = 7; // 'http://'.length
    } else {
      protocolPos = httpsPos;
      protocolLen = 8; // 'https://'.length
    }

    // Look for @ after the protocol
    const searchStart = protocolPos + protocolLen;
    const atPos = result.indexOf('@', searchStart);

    // Find where the URL ends (whitespace, quotes, or structural delimiters)
    let urlEnd = searchStart;
    while (urlEnd < result.length) {
      const char = result[urlEnd];
      if (/[\s"'`<>,;{}[\]]/.test(char)) break;
      urlEnd++;
    }

    if (atPos !== -1 && atPos < urlEnd) {
      result = `${result.substring(0, searchStart)}******${result.substring(atPos)}`;
      pos = searchStart + 6; // Move past '******'
    } else {
      pos = protocolPos + protocolLen;
    }
  }

  return result;
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
    const result: Record<string, unknown> = {};
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

  private sanitizeError(error?: Error): Error | undefined {
    if (!error) return error;

    // Create a new error with sanitized message and stack
    const sanitized = new Error(redactCredentials(error.message));
    sanitized.name = error.name;
    if (error.stack) {
      sanitized.stack = redactCredentials(error.stack);
    }
    // Preserve other enumerable properties
    const sanitizedRecord = sanitized as unknown as Record<string, unknown>;
    const errorRecord = error as unknown as Record<string, unknown>;
    for (const key of Object.keys(error)) {
      if (key !== 'message' && key !== 'stack' && key !== 'name') {
        sanitizedRecord[key] = sanitizeGitData(errorRecord[key]);
      }
    }
    return sanitized;
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
    this.baseLogger.error(
      message,
      this.sanitizeError(error),
      this.sanitizeContext(context)
    );
  }

  child(context: Partial<LogContext>): Logger {
    const sanitized = sanitizeGitData(context) as Partial<LogContext>;
    const childLogger = this.baseLogger.child(sanitized);
    return new GitLogger(childLogger);
  }
}
