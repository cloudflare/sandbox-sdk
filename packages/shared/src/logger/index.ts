/**
 * Logger module
 *
 * Provides structured, trace-aware logging with:
 * - Explicit logger passing via constructor injection
 * - Pretty printing for local development
 * - JSON output for production
 * - Environment auto-detection
 * - Log level configuration
 *
 * Usage:
 *
 * ```typescript
 * // Create a logger at entry point
 * const logger = createLogger({ component: 'sandbox-do', traceId: 'tr_abc123' });
 *
 * // Pass to classes via constructor
 * const service = new MyService(logger);
 *
 * // Create child loggers for additional context
 * const execLogger = logger.child({ operation: 'exec', commandId: 'cmd-456' });
 * execLogger.info('Operation started');
 * ```
 */
import { CloudflareLogger } from './logger.js';
import { TraceContext } from './trace-context.js';
import type { LogComponent, LogContext, Logger, LogLevel } from './types.js';
import { LogLevel as LogLevelEnum } from './types.js';

// Export all public types and classes
export type { Logger, LogContext, LogLevel };
export { CloudflareLogger } from './logger.js';
export { TraceContext } from './trace-context.js';
export { LogLevel as LogLevelEnum } from './types.js';

/**
 * Create a no-op logger for testing
 *
 * Returns a logger that implements the Logger interface but does nothing.
 * Useful for tests that don't need actual logging output.
 *
 * @returns No-op logger instance
 *
 * @example
 * ```typescript
 * // In tests
 * const client = new HttpClient({
 *   baseUrl: 'http://test.com',
 *   logger: createNoOpLogger() // Optional - tests can enable real logging if needed
 * });
 * ```
 */
export function createNoOpLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createNoOpLogger()
  };
}

/**
 * Create a new logger instance
 *
 * @param context Base context for the logger. Must include 'component'.
 *                TraceId will be auto-generated if not provided.
 * @returns New logger instance
 *
 * @example
 * ```typescript
 * // In Durable Object
 * const logger = createLogger({
 *   component: 'sandbox-do',
 *   traceId: TraceContext.fromHeaders(request.headers) || TraceContext.generate(),
 *   sandboxId: this.id
 * });
 *
 * // In Container
 * const logger = createLogger({
 *   component: 'container',
 *   traceId: TraceContext.fromHeaders(request.headers)!,
 *   sessionId: this.id
 * });
 * ```
 */
export function createLogger(
  context: Partial<LogContext> & { component: LogComponent }
): Logger {
  const minLevel = getLogLevelFromEnv();
  const pretty = isPrettyPrintEnabled();

  const baseContext: LogContext = {
    ...context,
    traceId: context.traceId || TraceContext.generate(),
    component: context.component
  };

  return new CloudflareLogger(baseContext, minLevel, pretty);
}

/**
 * Get log level from environment variable
 *
 * Checks SANDBOX_LOG_LEVEL env var, falls back to default based on environment.
 * Default: 'debug' for development, 'info' for production
 */
function getLogLevelFromEnv(): LogLevel {
  const envLevel = getEnvVar('SANDBOX_LOG_LEVEL') || 'info';

  switch (envLevel.toLowerCase()) {
    case 'debug':
      return LogLevelEnum.DEBUG;
    case 'info':
      return LogLevelEnum.INFO;
    case 'warn':
      return LogLevelEnum.WARN;
    case 'error':
      return LogLevelEnum.ERROR;
    default:
      // Invalid level, fall back to info
      return LogLevelEnum.INFO;
  }
}

/**
 * Check if pretty printing should be enabled
 *
 * Checks SANDBOX_LOG_FORMAT env var, falls back to auto-detection:
 * - Local development: pretty (colored, human-readable)
 * - Production: json (structured)
 */
function isPrettyPrintEnabled(): boolean {
  // Check explicit SANDBOX_LOG_FORMAT env var
  const format = getEnvVar('SANDBOX_LOG_FORMAT');
  if (format) {
    return format.toLowerCase() === 'pretty';
  }

  return false;
}

/**
 * Get environment variable value
 *
 * Supports both Node.js (process.env) and Bun (Bun.env)
 */
function getEnvVar(name: string): string | undefined {
  // Try process.env first (Node.js / Bun)
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }

  // Try Bun.env (Bun runtime)
  if (typeof Bun !== 'undefined') {
    const bunEnv = (Bun as any).env as
      | Record<string, string | undefined>
      | undefined;
    if (bunEnv) {
      return bunEnv[name];
    }
  }

  return undefined;
}
