// Core Types

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
}

// Background Process Types

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

// Streaming Types

export interface ExecEvent {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  result?: ExecResult;
  error?: string; // Changed to string for serialization
}

export interface LogEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  exitCode?: number; // For 'exit' events
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

// Error Types

export class SandboxError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class ProcessNotFoundError extends SandboxError {
  constructor(processId: string) {
    super(`Process not found: ${processId}`, 'PROCESS_NOT_FOUND');
    this.name = 'ProcessNotFoundError';
  }
}

export class ProcessAlreadyExistsError extends SandboxError {
  constructor(processId: string) {
    super(`Process already exists: ${processId}`, 'PROCESS_EXISTS');
    this.name = 'ProcessAlreadyExistsError';
  }
}

export class ExecutionTimeoutError extends SandboxError {
  constructor(timeout: number) {
    super(`Execution timed out after ${timeout}ms`, 'EXECUTION_TIMEOUT');
    this.name = 'ExecutionTimeoutError';
  }
}

// Internal Container Types

export interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;

  // Internal fields
  childProcess?: any;  // Node.js ChildProcess
  stdout: string;      // Accumulated output (ephemeral)
  stderr: string;      // Accumulated output (ephemeral)

  // Streaming
  outputListeners: Set<(stream: 'stdout' | 'stderr', data: string) => void>;
  statusListeners: Set<(status: ProcessStatus) => void>;
}

// Container Request/Response Types

export interface StartProcessRequest {
  command: string;
  options?: {
    processId?: string;
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    encoding?: string;
    autoCleanup?: boolean;
  };
}

export interface StartProcessResponse {
  process: {
    id: string;
    pid?: number;
    command: string;
      status: ProcessStatus;
    startTime: string;
  };
}

export interface ListProcessesResponse {
  processes: Array<{
    id: string;
    pid?: number;
    command: string;
      status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
  }>;
}

export interface GetProcessResponse {
  process: {
    id: string;
    pid?: number;
    command: string;
      status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
  } | null;
}

export interface GetProcessLogsResponse {
  stdout: string;
  stderr: string;
  processId: string;
}

// Import code interpreter types
import type {
  CodeContext,
  CreateContextOptions,
  ExecutionResult, 
  RunCodeOptions
} from './interpreter-types';

// Main Sandbox Interface

export interface ISandbox {
  // Enhanced execution API
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // Background process management
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  listProcesses(): Promise<Process[]>;
  getProcess(id: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;

  // Advanced streaming - returns ReadableStream that can be converted to AsyncIterable
  execStream(command: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
  streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;

  // Utility methods
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;

  // File operations
  gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<GitCheckoutResponse>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResponse>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<WriteFileResponse>;
  deleteFile(path: string): Promise<DeleteFileResponse>;
  renameFile(oldPath: string, newPath: string): Promise<RenameFileResponse>;
  moveFile(sourcePath: string, destinationPath: string): Promise<MoveFileResponse>;
  readFile(path: string, options?: { encoding?: string }): Promise<ReadFileResponse>;
  listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<ListFilesResponse>;

  // Port management
  exposePort(port: number, options: { name?: string; hostname: string }): Promise<{ url: string; port: number; name?: string }>;
  unexposePort(port: number): Promise<void>;
  getExposedPorts(hostname: string): Promise<Array<{ url: string; port: number; name?: string; exposedAt: string }>>;

  // Environment management
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  setSandboxName(name: string): Promise<void>;

  // Code Interpreter API
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext>;
  runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>;
  runCodeStream(code: string, options?: RunCodeOptions): Promise<ReadableStream>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(contextId: string): Promise<void>;
}

// Execution session returned by createSession()
// Sessions are full-featured sandbox objects with scoped execution context
export interface ExecutionSession extends Omit<ISandbox, 'createSession' | 'setSandboxName'> {
  /**
   * Session name
   */
  name: string;
  
  // Inherits all ISandbox methods:
  // - Command execution: exec, execStream
  // - Process management: startProcess, listProcesses, getProcess, killProcess, etc.
  // - File operations: writeFile, readFile, mkdir, deleteFile, etc.
  // - Port management: exposePort, unexposePort, getExposedPorts
  // - Code interpreter: createCodeContext, runCode, listCodeContexts, etc.
  // - Environment: setEnvVars
  // 
  // Excludes: createSession (sessions can't create sub-sessions), setSandboxName (sessions inherit sandbox name)
}

// API Response Types

export interface ExecuteResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  timestamp: string;
}

export interface GitCheckoutResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  repoUrl: string;
  branch: string;
  targetDir: string;
  timestamp: string;
}

export interface MkdirResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  path: string;
  recursive: boolean;
  timestamp: string;
}

export interface WriteFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  timestamp: string;
}

export interface ReadFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  content: string;
  timestamp: string;
}

export interface DeleteFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  timestamp: string;
}

export interface RenameFileResponse {
  success: boolean;
  exitCode: number;
  oldPath: string;
  newPath: string;
  timestamp: string;
}

export interface MoveFileResponse {
  success: boolean;
  exitCode: number;
  sourcePath: string;
  destinationPath: string;
  timestamp: string;
}

export interface ListFilesResponse {
  success: boolean;
  exitCode: number;
  path: string;
  files: Array<{
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
  }>;
  timestamp: string;
}

// Type Guards

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