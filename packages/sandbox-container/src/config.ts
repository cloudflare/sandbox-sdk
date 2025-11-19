/**
 * How long to wait for an interpreter process to spawn and become ready.
 * If an interpreter doesn't start within this time, something is fundamentally
 * broken (missing dependencies, corrupt install, etc.)
 *
 * Default: 60 seconds
 * Environment variable: INTERPRETER_SPAWN_TIMEOUT_MS
 */
const INTERPRETER_SPAWN_TIMEOUT_MS = parseInt(
  process.env.INTERPRETER_SPAWN_TIMEOUT_MS || '60000',
  10
);

/**
 * Timeout for interpreter code execution (Python/JS/TS).
 * Users might legitimately run long computations (ML training, data processing, etc.)
 *
 * Default: undefined (unlimited)
 * Set to 0 or omit the environment variable for unlimited execution.
 * Environment variable: INTERPRETER_EXECUTION_TIMEOUT_MS
 */
const INTERPRETER_EXECUTION_TIMEOUT_MS = (() => {
  const val = parseInt(process.env.INTERPRETER_EXECUTION_TIMEOUT_MS || '0', 10);
  return val === 0 ? undefined : val;
})();

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
 * Maximum output size in bytes to prevent OOM attacks.
 * This is a security measure, not a timeout.
 *
 * Default: 10MB
 * Environment variable: MAX_OUTPUT_SIZE_BYTES
 */
const MAX_OUTPUT_SIZE_BYTES = parseInt(
  process.env.MAX_OUTPUT_SIZE_BYTES || String(10 * 1024 * 1024),
  10
);

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
  INTERPRETER_SPAWN_TIMEOUT_MS,
  INTERPRETER_EXECUTION_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_SIZE_BYTES,
  STREAM_CHUNK_DELAY_MS,
  DEFAULT_CWD
} as const;
