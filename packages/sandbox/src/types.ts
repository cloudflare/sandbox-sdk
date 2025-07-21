// Core Types

export interface BaseExecOptions {
  /**
   * Session ID for grouping related commands
   */
  sessionId?: string;

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
   * Arguments passed to command
   */
  args: string[];

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
   * Arguments passed to command
   */
  readonly args: string[];

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

// Streaming Types

export interface ExecEvent {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  command?: string;
  args?: string[];
  exitCode?: number;
  result?: ExecResult;
  error?: Error;
}

export interface LogEvent {
  type: 'stdout' | 'stderr' | 'status' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
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
  args: string[];
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  sessionId?: string;

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
  args: string[];
  options?: {
    processId?: string;
    sessionId?: string;
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
    args: string[];
    status: ProcessStatus;
    startTime: string;
    sessionId?: string;
  };
}

export interface ListProcessesResponse {
  processes: Array<{
    id: string;
    pid?: number;
    command: string;
    args: string[];
    status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    sessionId?: string;
  }>;
}

export interface GetProcessResponse {
  process: {
    id: string;
    pid?: number;
    command: string;
    args: string[];
    status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    sessionId?: string;
  } | null;
}

export interface GetProcessLogsResponse {
  stdout: string;
  stderr: string;
  processId: string;
}

// Main Sandbox Interface

export interface ISandbox {
  // Enhanced execution API
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

  // Background process management
  startProcess(command: string, args: string[], options?: ProcessOptions): Promise<Process>;
  listProcesses(): Promise<Process[]>;
  getProcess(id: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;

  // Advanced streaming
  execStream(command: string, args: string[], options?: StreamOptions): AsyncIterable<ExecEvent>;
  streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncIterable<LogEvent>;

  // Utility methods
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
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
    Array.isArray(value.args) &&
    typeof value.status === 'string';
}

export function isProcessStatus(value: string): value is ProcessStatus {
  return ['starting', 'running', 'completed', 'failed', 'killed', 'error'].includes(value);
}