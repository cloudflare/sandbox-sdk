/**
 * Logger module
 *
 * Provides structured, trace-aware logging with:
 * - AsyncLocalStorage for implicit context propagation
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
 * // Store in AsyncLocalStorage for entire request
 * await runWithLogger(logger, async () => {
 *   await handleRequest();
 * });
 *
 * // Retrieve logger anywhere in call stack
 * const logger = getLogger();
 * logger.info('Operation started');
 *
 * // Add operation-specific context
 * const execLogger = logger.child({ operation: 'exec', commandId: 'cmd-456' });
 * await runWithLogger(execLogger, async () => {
 *   // All nested calls automatically get execLogger
 *   await executeCommand();
 * });
 * ```
 */

import { AsyncLocalStorage } from 'node:async_hooks';
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
 * AsyncLocalStorage for logger context
 *
 * Enables implicit logger propagation throughout the call stack without
 * explicit parameter passing. The logger is stored per async context.
 */
const loggerStorage = new AsyncLocalStorage<Logger>();

/**
 * Get the current logger from AsyncLocalStorage
 *
 * @throws Error if no logger is initialized in the current async context
 * @returns Current logger instance
 *
 * @example
 * ```typescript
 * function someHelperFunction() {
 *   const logger = getLogger(); // Automatically has all context!
 *   logger.info('Helper called');
 * }
 * ```
 */
export function getLogger(): Logger {
  const logger = loggerStorage.getStore();
  if (!logger) {
    throw new Error(
      'Logger not initialized in async context. ' +
        'Ensure runWithLogger() is called at the entry point (e.g., fetch handler).'
    );
  }
  return logger;
}

/**
 * Run a function with a logger stored in AsyncLocalStorage
 *
 * The logger is available to all code within the function via getLogger().
 * This is typically called at request entry points (fetch handler) and when
 * creating child loggers with additional context.
 *
 * @param logger Logger instance to store in context
 * @param fn Function to execute with logger context
 * @returns Result of the function
 *
 * @example
 * ```typescript
 * // At request entry point
 * async fetch(request: Request): Promise<Response> {
 *   const logger = createLogger({ component: 'sandbox-do', traceId: 'tr_abc' });
 *   return runWithLogger(logger, async () => {
 *     return await this.handleRequest(request);
 *   });
 * }
 *
 * // When adding operation context
 * async exec(command: string) {
 *   const logger = getLogger().child({ operation: 'exec', commandId: 'cmd-123' });
 *   return runWithLogger(logger, async () => {
 *     logger.info('Command started');
 *     await this.executeCommand(command); // Nested calls get the child logger
 *     logger.info('Command completed');
 *   });
 * }
 * ```
 */
export function runWithLogger<T>(
  logger: Logger,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return loggerStorage.run(logger, fn);
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
