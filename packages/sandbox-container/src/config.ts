/**
 * Timeout for foreground shell command execution.
 * Users might run long builds, installations, or processes.
 *
 * Default: undefined (unlimited)
 * Set to 0 or omit the environment variable for unlimited execution.
 * Environment variable: COMMAND_TIMEOUT_MS
 */
const COMMAND_TIMEOUT_MS = (() => {
  const val = parseInt(process.env.COMMAND_TIMEOUT_MS || '0', 10);
  return val === 0 ? undefined : val;
})();

/**
 * Delay between chunks when streaming output.
 * This debounces file system watch events for better performance.
 *
 * Default: 100ms
 */
const STREAM_CHUNK_DELAY_MS = 100;

/**
 * Default working directory for sessions.
 *
 * Default: /workspace
 */
const DEFAULT_CWD = '/workspace';

export const CONFIG = {
  COMMAND_TIMEOUT_MS,
  STREAM_CHUNK_DELAY_MS,
  DEFAULT_CWD
} as const;
