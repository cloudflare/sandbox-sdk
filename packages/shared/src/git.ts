import type { LogContext, Logger } from './logger';
import { redactCommand } from './logger/sanitize.js';

/**
 * Fallback repository name used when URL parsing fails
 */
export const FALLBACK_REPO_NAME = 'repository';

/**
 * Extract repository name from a Git URL
 *
 * Supports multiple URL formats:
 * - HTTPS: https://github.com/user/repo.git → repo
 * - HTTPS without .git: https://github.com/user/repo → repo
 * - SSH: git@github.com:user/repo.git → repo
 * - GitLab/others: https://gitlab.com/org/project.git → project
 *
 * @param repoUrl - Git repository URL (HTTPS or SSH format)
 * @returns Repository name extracted from URL, or 'repository' as fallback
 */
export function extractRepoName(repoUrl: string): string {
  // Try parsing as standard URL (https://, http://)
  try {
    const url = new URL(repoUrl);
    const pathParts = url.pathname.split('/');
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart) {
      return lastPart.replace(/\.git$/, '');
    }
  } catch {
    // Not a standard URL, try SSH format
  }

  // For SSH URLs (git@github.com:user/repo.git), split by : and / to get last segment
  // Only process if the URL contains path delimiters
  if (repoUrl.includes(':') || repoUrl.includes('/')) {
    const segments = repoUrl.split(/[:/]/).filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment) {
      return lastSegment.replace(/\.git$/, '');
    }
  }

  return FALLBACK_REPO_NAME;
}

/**
 * Sanitize data by redacting credentials from any strings
 * Recursively processes objects and arrays to ensure credentials are never leaked
 */
export function sanitizeGitData<T>(data: T): T {
  // Handle primitives
  if (typeof data === 'string') {
    return redactCommand(data) as T;
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
    const sanitized = new Error(redactCommand(error.message));
    sanitized.name = error.name;
    if (error.stack) {
      sanitized.stack = redactCommand(error.stack);
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
