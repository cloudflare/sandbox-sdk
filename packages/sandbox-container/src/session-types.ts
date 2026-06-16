import type { Logger } from '@repo/shared';

export interface SessionOptions {
  /** Session identifier (generated if not provided) */
  id: string;

  /**
   * Initial working directory for the shell.
   *
   * Note: This only affects where the shell starts. Individual commands can
   * specify their own cwd via exec options, and the shell can cd anywhere.
   * If the specified directory doesn't exist when the session initializes,
   * the session will fall back to the home directory.
   */
  cwd?: string;

  /** Environment variables for the session. Undefined values are skipped. */
  env?: Record<string, string | undefined>;

  /** Legacy isolation flag (ignored - kept for compatibility) */
  isolation?: boolean;

  /** Command timeout in milliseconds (overrides CONFIG.COMMAND_TIMEOUT_MS) */
  commandTimeoutMs?: number;

  /** Logger instance for structured logging (optional - uses no-op logger if not provided) */
  logger?: Logger;
}

export interface RawExecResult {
  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Process exit code */
  exitCode: number;

  /** Command that was executed */
  command: string;

  /** Execution duration in milliseconds */
  duration: number;

  /** ISO timestamp when command started */
  timestamp: string;
}
