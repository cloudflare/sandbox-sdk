import type { SandboxTerminal, TerminalOptions } from './pty-types';

/**
 * Represents a disposable resource with a cleanup function.
 * Common pattern used by VS Code, xterm.js, RxJS, and others.
 */
export interface Disposable {
  dispose(): void;
}

// Base execution options shared across command types
export interface BaseExecOptions {
  /**
   * Maximum execution time in milliseconds
   */
  timeout?: number;

  /**
   * Environment variables for this command invocation.
   * Values temporarily override session-level/container-level env for the
   * duration of the command but do not persist after it completes.
   * Undefined values are skipped (treated as "not configured").
   */
  env?: Record<string, string | undefined>;

  /**
   * Working directory for command execution
   */
  cwd?: string;

  /**
   * Text encoding for output (default: 'utf8')
   */
  encoding?: string;
}

// Command execution types
export interface ExecOptions extends BaseExecOptions {
  /**
   * Whether this command was initiated by the user or by internal
   * infrastructure (backup, bucket mount, env setup, etc.).
   * Defaults to 'user' when omitted.
   */
  origin?: 'user' | 'internal';
}

export interface ExecResult {
  /**
   * Whether the command succeeded (exitCode === 0)
   */
  success: boolean;

  /**
   * Process exit code
   */
  exitCode: number;

  /**
   * Standard output content
   */
  stdout: string;

  /**
   * Standard error content
   */
  stderr: string;

  /**
   * Command that was executed
   */
  command: string;

  /**
   * Execution duration in milliseconds
   */
  duration: number;

  /**
   * ISO timestamp when command started
   */
  timestamp: string;

  /**
   * Session ID if provided
   */
  sessionId?: string;
}

/**
 * Result from waiting for a log pattern
 */
export interface WaitForLogResult {
  /** The log line that matched */
  line: string;
  /** Regex capture groups (if condition was a RegExp) */
  match?: RegExpMatchArray;
}

/**
 * Result from waiting for process exit
 */
export interface WaitForExitResult {
  /** Process exit code */
  exitCode: number;
}

/**
 * Options for waiting for a port to become ready
 */
export interface WaitForPortOptions {
  /**
   * Check mode
   * - 'http': Make an HTTP request and check for success status (default)
   * - 'tcp': Just check if TCP connection succeeds
   * @default 'http'
   */
  mode?: 'http' | 'tcp';

  /**
   * HTTP path to check (only used when mode is 'http')
   * @default '/'
   */
  path?: string;

  /**
   * Expected HTTP status code or range (only used when mode is 'http')
   * - Single number: exact match (e.g., 200)
   * - Object with min/max: range match (e.g., { min: 200, max: 399 })
   * @default { min: 200, max: 399 }
   */
  status?: number | { min: number; max: number };

  /**
   * Maximum time to wait in milliseconds
   * @default no timeout
   */
  timeout?: number;

  /**
   * Interval between checks in milliseconds
   * @default 500
   */
  interval?: number;
}

/**
 * Request body for port readiness check endpoint
 */
export interface PortCheckRequest {
  port: number;
  mode: 'http' | 'tcp';
  path?: string;
  statusMin?: number;
  statusMax?: number;
}

/**
 * Response from port readiness check endpoint
 */
export interface PortCheckResponse {
  ready: boolean;
  /** HTTP status code received (only for http mode) */
  statusCode?: number;
  /** Error message if check failed */
  error?: string;
}

/**
 * Request body for streaming port watch endpoint
 */
export interface PortWatchRequest extends PortCheckRequest {
  /** Process ID to monitor - stream closes if process exits */
  processId?: string;
  /** Internal polling interval in ms (default: 500) */
  interval?: number;
}

/**
 * SSE event emitted by port watch stream
 */
export interface PortWatchEvent {
  type: 'watching' | 'ready' | 'process_exited' | 'error';
  port: number;
  /** HTTP status code (for 'ready' events with HTTP mode) */
  statusCode?: number;
  /** Process exit code (for 'process_exited' events) */
  exitCode?: number;
  /** Error message (for 'error' events) */
  error?: string;
}

// Background process types
export interface ProcessOptions extends BaseExecOptions {
  /**
   * Optional session ID to run the background process in.
   *
   * When omitted, the sandbox's default execution policy applies.
   */
  sessionId?: string;

  /**
   * Custom process ID for later reference
   * If not provided, a UUID will be generated
   */
  processId?: string;

  /**
   * Automatically cleanup process record after exit (default: true)
   */
  autoCleanup?: boolean;

  /**
   * Callback when process exits
   */
  onExit?: (code: number | null) => void;

  /**
   * Callback for real-time output (background processes)
   */
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;

  /**
   * Callback when process starts successfully
   */
  onStart?: (process: Process) => void;

  /**
   * Callback for process errors
   */
  onError?: (error: Error) => void;
}

export type ProcessStatus =
  | 'starting' // Process is being initialized
  | 'running' // Process is actively running
  | 'completed' // Process exited successfully (code 0)
  | 'failed' // Process exited with non-zero code
  | 'killed' // Process was terminated by signal
  | 'error'; // Process failed to start or encountered error

/**
 * Check if a process status indicates the process has terminated
 */
export function isTerminalStatus(status: ProcessStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'error'
  );
}

export interface Process {
  /**
   * Unique process identifier
   */
  readonly id: string;

  /**
   * System process ID (if available and running)
   */
  readonly pid?: number;

  /**
   * Command that was executed
   */
  readonly command: string;

  /**
   * Current process status
   */
  readonly status: ProcessStatus;

  /**
   * When the process was started
   */
  readonly startTime: Date;

  /**
   * When the process ended (if completed)
   */
  readonly endTime?: Date;

  /**
   * Process exit code (if completed)
   */
  readonly exitCode?: number;

  /**
   * Session ID if provided
   */
  readonly sessionId?: string;

  /**
   * Kill the process
   */
  kill(signal?: string): Promise<void>;

  /**
   * Get current process status (refreshed)
   */
  getStatus(): Promise<ProcessStatus>;

  /**
   * Get accumulated logs
   */
  getLogs(): Promise<{ stdout: string; stderr: string }>;

  /**
   * Wait for a log pattern to appear in process output
   *
   * @example
   * const proc = await sandbox.startProcess("python train.py");
   * await proc.waitForLog("Epoch 1 complete");
   * await proc.waitForLog(/Epoch (\d+) complete/);
   */
  waitForLog(
    pattern: string | RegExp,
    timeout?: number
  ): Promise<WaitForLogResult>;

  /**
   * Wait for a port to become ready
   *
   * @example
   * // Wait for HTTP endpoint to return 200-399
   * const proc = await sandbox.startProcess("npm run dev");
   * await proc.waitForPort(3000);
   *
   * @example
   * // Wait for specific health endpoint
   * await proc.waitForPort(3000, { path: '/health', status: 200 });
   *
   * @example
   * // TCP-only check (just verify port is accepting connections)
   * await proc.waitForPort(5432, { mode: 'tcp' });
   */
  waitForPort(port: number, options?: WaitForPortOptions): Promise<void>;

  /**
   * Wait for the process to exit
   *
   * Returns the exit code. Use getProcessLogs() or streamProcessLogs()
   * to retrieve output after the process exits.
   */
  waitForExit(timeout?: number): Promise<WaitForExitResult>;
}

// Streaming event types
export interface ExecEvent {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  result?: ExecResult;
  error?: string;
  sessionId?: string;
  pid?: number; // Present on 'start' event
}

export interface LogEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
  exitCode?: number;
}

// Session management types
export interface SessionOptions {
  /**
   * Optional session ID (auto-generated if not provided)
   */
  id?: string;

  /**
   * Session name for identification
   */
  name?: string;

  /**
   * Environment variables for this session.
   * Undefined values are skipped (treated as "not configured").
   */
  env?: Record<string, string | undefined>;

  /**
   * Working directory
   */
  cwd?: string;

  /**
   * Enable PID namespace isolation (requires CAP_SYS_ADMIN)
   */
  isolation?: boolean;

  /**
   * Maximum amount of time a command can run in milliseconds
   */
  commandTimeoutMs?: number;
}

// Sandbox configuration options
export interface SandboxOptions {
  /**
   * Duration after which the sandbox instance will sleep if no requests are received
   * Can be:
   * - A string like "30s", "3m", "5m", "1h" (seconds, minutes, or hours)
   * - A number representing seconds (e.g., 180 for 3 minutes)
   * Default: "10m" (10 minutes)
   *
   * Note: Ignored when keepAlive is true
   */
  sleepAfter?: string | number;

  /**
   * Keep the container alive indefinitely by preventing automatic shutdown
   * When true, the container will never auto-timeout and must be explicitly destroyed
   * - Any scenario where activity can't be automatically detected
   *
   * Important: You MUST call sandbox.destroy() when done to avoid resource leaks
   *
   * Default: false
   */
  keepAlive?: boolean;

  /**
   * When true (the default), implicit operations automatically create and reuse
   * a persistent default shell session. Set to false to run implicit top-level
   * operations sessionlessly, where each command spawns a fresh process with no
   * shared shell state. Explicit per-call session IDs continue to work normally
   * when this is false.
   *
   * Default: true
   */
  enableDefaultSession?: boolean;

  /**
   * Normalize sandbox ID to lowercase for preview URL compatibility
   *
   * Required for preview URLs because hostnames are case-insensitive (RFC 3986), which
   * would route requests to a different Durable Object instance with IDs containing uppercase letters.
   *
   * **Important:** Different normalizeId values create different Durable Object instances:
   * - `getSandbox(ns, "MyProject")` → DO key: "MyProject"
   * - `getSandbox(ns, "MyProject", {normalizeId: true})` → DO key: "myproject"
   *
   * **Future change:** In a future version, this will default to `true` (automatically lowercase all IDs).
   * IDs with uppercase letters will trigger a warning. To prepare, use lowercase IDs or explicitly
   * pass `normalizeId: true`.
   *
   * @example
   * getSandbox(ns, "my-project")  // Works with preview URLs (lowercase)
   * getSandbox(ns, "MyProject", {normalizeId: true})  // Normalized to "myproject"
   *
   * @default false
   */
  normalizeId?: boolean;

  /**
   * Container startup timeout configuration
   *
   * Tune timeouts based on your container's characteristics. SDK defaults (30s instance, 90s ports)
   * work for most use cases. Adjust for heavy containers or fail-fast applications.
   *
   * Can also be configured via environment variables:
   * - SANDBOX_INSTANCE_TIMEOUT_MS
   * - SANDBOX_PORT_TIMEOUT_MS
   * - SANDBOX_POLL_INTERVAL_MS
   *
   * Precedence: options > env vars > SDK defaults
   *
   * @example
   * // Heavy containers (ML models, large apps)
   * getSandbox(ns, id, {
   *   containerTimeouts: { portReadyTimeoutMS: 180_000 }
   * })
   *
   * @example
   * // Fail-fast for latency-sensitive apps
   * getSandbox(ns, id, {
   *   containerTimeouts: {
   *     instanceGetTimeoutMS: 15_000,
   *     portReadyTimeoutMS: 30_000
   *   }
   * })
   */
  containerTimeouts?: {
    /**
     * Time to wait for container instance provisioning
     * @default 30000 (30s) - or SANDBOX_INSTANCE_TIMEOUT_MS env var
     */
    instanceGetTimeoutMS?: number;

    /**
     * Time to wait for application startup and ports to be ready
     * @default 90000 (90s) - or SANDBOX_PORT_TIMEOUT_MS env var
     */
    portReadyTimeoutMS?: number;

    /**
     * How often to poll for container readiness
     * @default 300 (300ms) - or SANDBOX_POLL_INTERVAL_MS env var
     */
    waitIntervalMS?: number;
  };
}

/**
 * Execution session - isolated execution context within a sandbox
 * Returned by sandbox.createSession()
 * Provides the same API as ISandbox but bound to a specific session
 */
// File operation result types
export interface MkdirResult {
  success: boolean;
  path: string;
  recursive: boolean;
  timestamp: string;
  exitCode?: number;
}

export interface WriteFileResult {
  success: boolean;
  path: string;
  timestamp: string;
  exitCode?: number;
}

/**
 * Valid `encoding` values accepted by `readFile` / `writeFile` options.
 *
 * - `'utf-8'` / `'utf8'` — treat content as text.
 * - `'base64'` — treat content as base64-encoded binary.
 * - `'none'` — streaming variant of `readFile`, returns a
 *   `ReadableStream<Uint8Array>` of raw bytes (see `ReadFileStreamResult`).
 */
export type FileEncoding = 'utf-8' | 'utf8' | 'base64' | 'none';

export interface ReadFileResult {
  success: boolean;
  path: string;
  content: string;
  timestamp: string;
  exitCode?: number;

  /**
   * Encoding used for content (utf-8 for text, base64 for binary)
   */
  encoding?: 'utf-8' | 'base64';

  /**
   * Whether the file is detected as binary
   */
  isBinary?: boolean;

  /**
   * MIME type of the file (e.g., 'image/png', 'text/plain')
   */
  mimeType?: string;

  /**
   * File size in bytes
   */
  size?: number;
}

/**
 * Result of `readFile()` with `encoding: 'none'`.
 *
 * `content` is a raw binary `ReadableStream<Uint8Array>` delivered directly
 * over the capnp channel — no base64 encoding, no SSE framing, no buffering.
 */
export interface ReadFileStreamResult {
  success: true;
  path: string;
  content: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
  timestamp: string;
}

export interface DeleteFileResult {
  success: boolean;
  path: string;
  timestamp: string;
  exitCode?: number;
}

export interface RenameFileResult {
  success: boolean;
  path: string;
  newPath: string;
  timestamp: string;
  exitCode?: number;
}

export interface MoveFileResult {
  success: boolean;
  path: string;
  newPath: string;
  timestamp: string;
  exitCode?: number;
}

export interface FileExistsResult {
  success: boolean;
  path: string;
  exists: boolean;
  timestamp: string;
}

export interface FileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  mode: string;
  permissions: {
    readable: boolean;
    writable: boolean;
    executable: boolean;
  };
}

export interface ListFilesOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  /**
   * Optional session ID used to resolve relative paths and execution context.
   *
   * When omitted, the sandbox's default execution policy applies.
   */
  sessionId?: string;
}

export interface ListFilesResult {
  success: boolean;
  path: string;
  files: FileInfo[];
  count: number;
  timestamp: string;
  exitCode?: number;
}

export interface GitCheckoutResult {
  success: boolean;
  repoUrl: string;
  branch: string;
  targetDir: string;
  timestamp: string;
  exitCode?: number;
}

// File Streaming Types

/**
 * SSE events for file streaming
 */
export type FileStreamEvent =
  | {
      type: 'metadata';
      mimeType: string;
      size: number;
      isBinary: boolean;
      encoding: 'utf-8' | 'base64';
    }
  | {
      type: 'chunk';
      data: string; // base64 for binary, UTF-8 for text
    }
  | {
      type: 'complete';
      bytesRead: number;
    }
  | {
      type: 'error';
      error: string;
    };

/**
 * File metadata from streaming
 */
export interface FileMetadata {
  mimeType: string;
  size: number;
  isBinary: boolean;
  encoding: 'utf-8' | 'base64';
}

/**
 * File stream chunk - either string (text) or Uint8Array (binary, auto-decoded)
 */
export type FileChunk = string | Uint8Array;

// File Watch Types

/**
 * Options for watching a directory.
 *
 * `watch()` resolves only after the watcher is established on the filesystem.
 * The returned SSE stream can be consumed with `parseSSEStream()`.
 */
export interface WatchOptions {
  /**
   * Watch subdirectories recursively
   * @default true
   */
  recursive?: boolean;

  /**
   * Glob patterns to include (e.g., '*.ts', '*.js').
   * If not specified, all files are included.
   * Cannot be used together with `exclude`.
   */
  include?: string[];

  /**
   * Glob patterns to exclude (e.g., 'node_modules', '.git').
   * Cannot be used together with `include`.
   * @default ['.git', 'node_modules', '.DS_Store']
   */
  exclude?: string[];

  /**
   * Session to run the watch in.
   * If omitted, the default session is used.
   */
  sessionId?: string;
}

/**
 * Options for checking whether a path changed while disconnected.
 *
 * Pass the `version` returned from a previous `checkChanges()` call to learn
 * whether the path is unchanged, changed, or needs a full resync because the
 * retained change state was reset. Change state lives only for the current
 * container lifetime and may expire while idle.
 */
export interface CheckChangesOptions extends WatchOptions {
  /**
   * Version returned by a previous `checkChanges()` call.
   */
  since?: string;
}

// Internal types for SSE protocol (not user-facing)

/**
 * @internal SSE event types for container communication
 */
export type FileWatchEventType =
  | 'create'
  | 'modify'
  | 'delete'
  | 'move_from'
  | 'move_to'
  | 'attrib';

/**
 * @internal Request body for starting a file watch
 */
export interface WatchRequest {
  path: string;
  recursive?: boolean;
  events?: FileWatchEventType[];
  include?: string[];
  exclude?: string[];
  sessionId?: string;
}

/**
 * @internal Request body for checking retained change state.
 */
export interface CheckChangesRequest extends WatchRequest {
  since?: string;
}

/**
 * SSE events emitted by `sandbox.watch()`.
 */
export type FileWatchSSEEvent =
  | {
      type: 'watching';
      path: string;
      watchId: string;
    }
  | {
      type: 'event';
      eventType: FileWatchEventType;
      path: string;
      isDirectory: boolean;
      timestamp: string;
    }
  | {
      type: 'error';
      error: string;
    }
  | {
      type: 'stopped';
      reason: string;
    };

/**
 * Result returned by `checkChanges()`.
 */
export type CheckChangesResult =
  | {
      success: true;
      status: 'unchanged' | 'changed';
      version: string;
      timestamp: string;
    }
  | {
      success: true;
      status: 'resync';
      reason: 'expired' | 'restarted';
      version: string;
      timestamp: string;
    };

// Process management result types
export interface ProcessStartResult {
  success: boolean;
  processId: string;
  pid?: number;
  command: string;
  timestamp: string;
}

export interface ProcessListResult {
  success: boolean;
  processes: Array<{
    id: string;
    pid?: number;
    command: string;
    status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
  }>;
  timestamp: string;
}

export interface ProcessInfoResult {
  success: boolean;
  process: {
    id: string;
    pid?: number;
    command: string;
    status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
  };
  timestamp: string;
}

export interface ProcessKillResult {
  success: boolean;
  processId: string;
  signal?: string;
  timestamp: string;
}

export interface ProcessLogsResult {
  success: boolean;
  processId: string;
  stdout: string;
  stderr: string;
  timestamp: string;
}

export interface ProcessCleanupResult {
  success: boolean;
  message?: string;
  killedCount?: number;
  cleanedCount: number;
  timestamp: string;
}

// Session management result types
export interface SessionCreateResult {
  success: boolean;
  sessionId: string;
  name?: string;
  cwd?: string;
  timestamp: string;
}

export interface SessionDeleteResult {
  success: boolean;
  sessionId: string;
  timestamp: string;
}

export interface EnvSetResult {
  success: boolean;
  timestamp: string;
}

export interface PortExposeResult {
  url: string;
  port: number;
  name?: string;
}

// Miscellaneous result types
export interface HealthCheckResult {
  success: boolean;
  status: 'healthy' | 'unhealthy';
  timestamp: string;
}

export interface ShutdownResult {
  success: boolean;
  message: string;
  timestamp: string;
}

export interface ExecutionSession {
  /** Unique session identifier */
  readonly id: string;

  // Command execution
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // Background process management
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  listProcesses(sessionId?: string): Promise<Process[]>;
  getProcess(id: string, sessionId?: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string; processId: string }>;
  streamProcessLogs(
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>>;

  // File operations
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string }
  ): Promise<WriteFileResult>;
  readFile(
    path: string,
    options: { encoding: 'none' }
  ): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'> }
  ): Promise<ReadFileResult>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  watch(
    path: string,
    options?: Omit<WatchOptions, 'sessionId'>
  ): Promise<ReadableStream<Uint8Array>>;
  checkChanges(
    path: string,
    options?: Omit<CheckChangesOptions, 'sessionId'>
  ): Promise<CheckChangesResult>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>;
  deleteFile(path: string): Promise<DeleteFileResult>;
  renameFile(oldPath: string, newPath: string): Promise<RenameFileResult>;
  moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<MoveFileResult>;
  listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
  exists(path: string): Promise<FileExistsResult>;

  // Git operations
  gitCheckout(
    repoUrl: string,
    options?: {
      branch?: string;
      targetDir?: string;
      /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
      depth?: number;
      /** Maximum wall-clock time for the git clone subprocess in milliseconds */
      cloneTimeoutMs?: number;
    }
  ): Promise<GitCheckoutResult>;

  // Environment management
  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;

  // Bucket mounting operations
  mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void>;
  unmountBucket(mountPath: string): Promise<void>;

  // Backup operations
  createBackup(options: BackupOptions): Promise<DirectoryBackup>;
  restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult>;
}

// Backup types
/**
 * Options for creating a directory backup
 */
export interface BackupCompressionOptions {
  format?: 'gzip' | 'lz4' | 'zstd';
  threads?: number;
}

export interface BackupOptions {
  /** Directory to back up. Must be absolute and under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`. */
  dir: string;
  /** Human-readable name for this backup. Optional. */
  name?: string;
  /** Seconds until automatic garbage collection. Default: 259200 (3 days). No upper limit. */
  ttl?: number;
  /**
   * Respect git ignore rules for the backup directory when it is inside a git repository.
   *
   * Default: false.
   * If the directory is not inside a git repository, no git-based exclusions are applied.
   * If git is not installed in the container, a warning is logged and gitignore rules are skipped.
   */
  gitignore?: boolean;
  /**
   * Glob patterns to exclude from the backup.
   * These are passed directly to mksquashfs as wildcard exclude patterns.
   *
   * @example ['node_modules', '*.log', '.cache']
   */
  excludes?: string[];
  /**
   * Use local R2 binding for backup storage instead of presigned URLs.
   * Required for local development where presigned URLs and FUSE are unavailable.
   * When true, the DO resolves BACKUP_BUCKET from its own env as an R2 binding.
   */
  localBucket?: boolean;
  compression?: BackupCompressionOptions;
  /**
   * Use parallel multipart upload to R2 for large archives.
   * Significantly speeds up uploads for archives over 10 MiB.
   * Default: true.
   */
  multipart?: boolean;
}

/**
 * Handle representing a stored directory backup.
 * Serializable metadata returned by createBackup().
 * Store it anywhere and later pass it to restoreBackup().
 */
export interface DirectoryBackup {
  /** Unique backup identifier */
  readonly id: string;
  /** Directory to restore into. Must be under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`. */
  readonly dir: string;
  /** Whether this backup was created with local R2 binding mode. */
  readonly localBucket?: boolean;
}

/**
 * Result returned from a successful restoreBackup() call
 */
export interface RestoreBackupResult {
  success: boolean;
  /** The directory that was restored */
  dir: string;
  /** Backup ID that was restored */
  id: string;
}

// Bucket mounting types
/**
 * Supported S3-compatible storage providers
 */
export type BucketProvider =
  | 'r2' // Cloudflare R2
  | 's3' // Amazon S3
  | 'gcs'; // Google Cloud Storage

/**
 * Credentials for S3-compatible storage
 */
export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Options for mounting an S3-compatible bucket via s3fs-FUSE (production)
 */
export interface RemoteMountBucketOptions {
  /**
   * S3-compatible endpoint URL
   *
   * Examples:
   * - R2: 'https://abc123.r2.cloudflarestorage.com'
   * - AWS S3: 'https://s3.us-west-2.amazonaws.com'
   * - GCS: 'https://storage.googleapis.com'
   */
  endpoint: string;

  /**
   * Optional provider hint for automatic s3fs flag configuration
   * If not specified, will attempt to detect from endpoint URL.
   *
   * Examples:
   * - 'r2' - Cloudflare R2 (adds nomixupload)
   * - 's3' - Amazon S3 (standard configuration)
   * - 'gcs' - Google Cloud Storage (no special flags needed)
   */
  provider?: BucketProvider;

  /**
   * Explicit credentials (overrides env var auto-detection)
   */
  credentials?: BucketCredentials;

  /**
   * Mount filesystem as read-only
   * Default: false
   */
  readOnly?: boolean;

  /**
   * Advanced: Override or extend s3fs options
   *
   * These will be merged with provider-specific defaults.
   * To override defaults completely, specify all options here.
   *
   * Common options:
   * - 'use_path_request_style' - Use path-style URLs (bucket/path vs bucket.host/path)
   * - 'nomixupload' - Disable mixed multipart uploads (needed for some providers)
   * - 'nomultipart' - Disable all multipart operations
   * - 'sigv2' - Use signature version 2 instead of v4
   * - 'no_check_certificate' - Skip SSL certificate validation (dev/testing only)
   */
  s3fsOptions?: string[];

  /**
   * Optional prefix/subdirectory within the bucket to mount.
   *
   * When specified, only the contents under this prefix are visible at the
   * mount point, scoping the mount to a subdirectory of the bucket.
   *
   * Must start with '/' (e.g., '/workspaces/project123' or '/data/uploads/')
   */
  prefix?: string;

  /**
   * Keep real credentials in the Durable Object; write dummy credentials into
   * the container-side s3fs password file. Outbound s3fs requests are
   * intercepted by the DO, signed with real credentials, and forwarded to the
   * configured endpoint.
   *
   * Default: false (real credentials are written into the container)
   */
  credentialProxy?: boolean;
}

/**
 * Options for mounting a local R2 binding via bidirectional sync (local dev)
 *
 * Used during local development with `wrangler dev`. The Durable Object
 * resolves the R2 binding from its own env using the `bucket` parameter
 * and syncs files via polling instead of s3fs-FUSE.
 */
export interface LocalMountBucketOptions {
  /**
   * Must be true to indicate local R2 binding mode.
   */
  localBucket: true;

  /**
   * Optional prefix/subdirectory within the bucket to sync.
   *
   * When specified, only the contents under this prefix will be visible
   * at the mount point.
   */
  prefix?: string;

  /**
   * Mount filesystem as read-only
   * Default: false
   */
  readOnly?: boolean;
}

/**
 * Options for mounting an R2 binding via credential-less egress interception.
 */
export interface R2BindingMountBucketOptions {
  /**
   * Must not be set — distinguishes this variant from RemoteMountBucketOptions.
   */
  endpoint?: never;

  /**
   * Optional prefix/subdirectory within the bucket to mount.
   *
   * When specified, only the contents under this prefix will be visible
   * at the mount point.
   */
  prefix?: string;

  /**
   * Mount filesystem as read-only
   * Default: false
   */
  readOnly?: boolean;

  /**
   * Advanced: Override or extend s3fs options.
   * Provider defaults for R2 are still applied automatically.
   */
  s3fsOptions?: string[];
}

/**
 * Options for mounting a bucket — remote (s3fs-FUSE), local (R2 binding sync),
 * or R2 egress (credential-less s3fs via egress interception).
 */
export type MountBucketOptions =
  | RemoteMountBucketOptions
  | LocalMountBucketOptions
  | R2BindingMountBucketOptions;

// Main Sandbox interface
export interface ISandbox {
  // Command execution
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // Background process management
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  listProcesses(sessionId?: string): Promise<Process[]>;
  getProcess(id: string, sessionId?: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;

  // Streaming operations
  streamProcessLogs(
    processId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>>;

  // Utility methods
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string; processId: string }>;

  // File operations
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string }
  ): Promise<WriteFileResult>;
  readFile(
    path: string,
    options: { encoding: 'none' }
  ): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: Exclude<FileEncoding, 'none'> }
  ): Promise<ReadFileResult>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  watch(
    path: string,
    options?: WatchOptions
  ): Promise<ReadableStream<Uint8Array>>;
  checkChanges(
    path: string,
    options?: CheckChangesOptions
  ): Promise<CheckChangesResult>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>;
  deleteFile(path: string): Promise<DeleteFileResult>;
  renameFile(oldPath: string, newPath: string): Promise<RenameFileResult>;
  moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<MoveFileResult>;
  listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
  exists(path: string, sessionId?: string): Promise<FileExistsResult>;

  // Git operations
  gitCheckout(
    repoUrl: string,
    options?: {
      branch?: string;
      targetDir?: string;
      sessionId?: string;
      /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
      depth?: number;
      /** Maximum wall-clock time for the git clone subprocess in milliseconds */
      cloneTimeoutMs?: number;
    }
  ): Promise<GitCheckoutResult>;

  // Environment management
  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;

  // Bucket mounting operations
  mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions
  ): Promise<void>;
  unmountBucket(mountPath: string): Promise<void>;

  // Session management
  createSession(options?: SessionOptions): Promise<ExecutionSession>;
  deleteSession(sessionId: string): Promise<SessionDeleteResult>;

  // Container metadata
  /**
   * Returns the Cloudflare placement ID observed during the most recent
   * session-create handshake with the container. `null` when the container
   * does not expose `CLOUDFLARE_PLACEMENT_ID` (local development). `undefined`
   * when no handshake has been observed yet on this sandbox.
   */
  getContainerPlacementId(): Promise<string | null | undefined>;

  // Backup operations
  createBackup(options: BackupOptions): Promise<DirectoryBackup>;
  restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult>;

  // WebSocket connection
  wsConnect(request: Request, port: number): Promise<Response>;

  // Terminal resources
  terminal(options?: TerminalOptions): SandboxTerminal;
}

// Type guards for runtime validation
export function isExecResult(value: any): value is ExecResult {
  return (
    value &&
    typeof value.success === 'boolean' &&
    typeof value.exitCode === 'number' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

export function isProcess(value: any): value is Process {
  return (
    value &&
    typeof value.id === 'string' &&
    typeof value.command === 'string' &&
    typeof value.status === 'string'
  );
}

export function isProcessStatus(value: string): value is ProcessStatus {
  return [
    'starting',
    'running',
    'completed',
    'failed',
    'killed',
    'error'
  ].includes(value);
}
