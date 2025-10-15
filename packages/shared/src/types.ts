import type { CodeContext, CreateContextOptions, ExecutionResult, RunCodeOptions } from './interpreter-types';

// Base execution options shared across command types
export interface BaseExecOptions {
  /**
   * Maximum execution time in milliseconds
   */
  timeout?: number;

  /**
   * Environment variables for the command
   */
  env?: Record<string, string>;

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
   * Enable real-time output streaming via callbacks
   */
  stream?: boolean;

  /**
   * Callback for real-time output data
   */
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;

  /**
   * Callback when command completes (only when stream: true)
   */
  onComplete?: (result: ExecResult) => void;

  /**
   * Callback for execution errors
   */
  onError?: (error: Error) => void;

  /**
   * AbortSignal for cancelling execution
   */
  signal?: AbortSignal;
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

// Background process types
export interface ProcessOptions extends BaseExecOptions {
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
  | 'starting'    // Process is being initialized
  | 'running'     // Process is actively running
  | 'completed'   // Process exited successfully (code 0)
  | 'failed'      // Process exited with non-zero code
  | 'killed'      // Process was terminated by signal
  | 'error';      // Process failed to start or encountered error

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
}

export interface LogEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
  exitCode?: number;
}

export interface StreamOptions extends BaseExecOptions {
  /**
   * Buffer size for streaming output
   */
  bufferSize?: number;

  /**
   * AbortSignal for cancelling stream
   */
  signal?: AbortSignal;
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
   * Environment variables for this session
   */
  env?: Record<string, string>;
  
  /**
   * Working directory
   */
  cwd?: string;
  
  /**
   * Enable PID namespace isolation (requires CAP_SYS_ADMIN)
   */
  isolation?: boolean;
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

// Port management result types
export interface PortExposeResult {
  success: boolean;
  port: number;
  url: string;
  timestamp: string;
}

export interface PortStatusResult {
  success: boolean;
  port: number;
  status: 'active' | 'inactive';
  url?: string;
  timestamp: string;
}

export interface PortListResult {
  success: boolean;
  ports: Array<{
    port: number;
    url: string;
    status: 'active' | 'inactive';
  }>;
  timestamp: string;
}

export interface PortCloseResult {
  success: boolean;
  port: number;
  timestamp: string;
}

// Code interpreter result types
export interface InterpreterHealthResult {
  success: boolean;
  status: 'healthy' | 'unhealthy';
  timestamp: string;
}

export interface ContextCreateResult {
  success: boolean;
  contextId: string;
  language: string;
  cwd?: string;
  timestamp: string;
}

export interface ContextListResult {
  success: boolean;
  contexts: Array<{
    id: string;
    language: string;
    cwd?: string;
  }>;
  timestamp: string;
}

export interface ContextDeleteResult {
  success: boolean;
  contextId: string;
  timestamp: string;
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
  execStream(command: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
  
  // Background process management
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  listProcesses(): Promise<Process[]>;
  getProcess(id: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string; processId: string }>;
  streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  
  // File operations
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<WriteFileResult>;
  readFile(path: string, options?: { encoding?: string }): Promise<ReadFileResult>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>;
  deleteFile(path: string): Promise<DeleteFileResult>;
  renameFile(oldPath: string, newPath: string): Promise<RenameFileResult>;
  moveFile(sourcePath: string, destinationPath: string): Promise<MoveFileResult>;
  listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;

  // Git operations
  gitCheckout(repoUrl: string, options?: { branch?: string; targetDir?: string }): Promise<GitCheckoutResult>;
  
  // Environment management
  setEnvVars(envVars: Record<string, string>): Promise<void>;

  // Code interpreter methods
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext>;
  runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>;
  runCodeStream(code: string, options?: RunCodeOptions): Promise<ReadableStream>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(contextId: string): Promise<void>;
}

// Main Sandbox interface
export interface ISandbox {
  // Command execution
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // Background process management
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  listProcesses(): Promise<Process[]>;
  getProcess(id: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;

  // Streaming operations
  execStream(command: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
  streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;

  // Utility methods
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string; processId: string }>;

  // File operations
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<WriteFileResult>;
  readFile(path: string, options?: { encoding?: string }): Promise<ReadFileResult>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>;
  deleteFile(path: string): Promise<DeleteFileResult>;
  renameFile(oldPath: string, newPath: string): Promise<RenameFileResult>;
  moveFile(sourcePath: string, destinationPath: string): Promise<MoveFileResult>;
  listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;

  // Git operations
  gitCheckout(repoUrl: string, options?: { branch?: string; targetDir?: string }): Promise<GitCheckoutResult>;

  // Session management
  createSession(options?: SessionOptions): Promise<ExecutionSession>;

  // Code interpreter methods
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext>;
  runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>;
  runCodeStream(code: string, options?: RunCodeOptions): Promise<ReadableStream>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(contextId: string): Promise<void>;
}

// Type guards for runtime validation
export function isExecResult(value: any): value is ExecResult {
  return value &&
    typeof value.success === 'boolean' &&
    typeof value.exitCode === 'number' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string';
}

export function isProcess(value: any): value is Process {
  return value &&
    typeof value.id === 'string' &&
    typeof value.command === 'string' &&
    typeof value.status === 'string';
}

export function isProcessStatus(value: string): value is ProcessStatus {
  return ['starting', 'running', 'completed', 'failed', 'killed', 'error'].includes(value);
}

export type {
  ChartData,
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  ExecutionResult,
  OutputMessage,
  Result,
  RunCodeOptions
} from './interpreter-types';
// Re-export interpreter types for convenience
export { Execution, ResultImpl } from './interpreter-types';

