# Sandbox SDK TypeScript Interfaces

Complete type definitions for the new execution API design.

## Core Types

### Base Execution Options

```typescript
interface BaseExecOptions {
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
```

### Enhanced exec() Options

```typescript
interface ExecOptions extends BaseExecOptions {
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
```

### Execution Result

```typescript
interface ExecResult {
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
```

## Background Process Types

### Process Options

```typescript
interface ProcessOptions extends BaseExecOptions {
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
```

### Process Object

```typescript
interface Process {
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
```

### Process Status

```typescript
type ProcessStatus = 
  | 'starting'    // Process is being initialized
  | 'running'     // Process is actively running
  | 'completed'   // Process exited successfully (code 0)
  | 'failed'      // Process exited with non-zero code
  | 'killed'      // Process was terminated by signal
  | 'error';      // Process failed to start or encountered error
```

## Streaming Types

### Streaming Events

```typescript
interface ExecEvent {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  result?: ExecResult;
  error?: Error;
}

interface LogEvent {
  type: 'stdout' | 'stderr' | 'status' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
}
```

### Advanced Streaming Options

```typescript
interface StreamOptions extends BaseExecOptions {
  /**
   * Buffer size for streaming output
   */
  bufferSize?: number;
  
  /**
   * AbortSignal for cancelling stream
   */
  signal?: AbortSignal;
}
```

## Error Types

### Custom Error Classes

```typescript
class SandboxError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

class ProcessNotFoundError extends SandboxError {
  constructor(processId: string) {
    super(`Process not found: ${processId}`, 'PROCESS_NOT_FOUND');
    this.name = 'ProcessNotFoundError';
  }
}

class ProcessAlreadyExistsError extends SandboxError {
  constructor(processId: string) {
    super(`Process already exists: ${processId}`, 'PROCESS_EXISTS');
    this.name = 'ProcessAlreadyExistsError';
  }
}

class ExecutionTimeoutError extends SandboxError {
  constructor(timeout: number) {
    super(`Execution timed out after ${timeout}ms`, 'EXECUTION_TIMEOUT');
    this.name = 'ExecutionTimeoutError';
  }
}
```

## Internal Container Types

### Process Record (Container Implementation)

```typescript
interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
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
```

### Container Request/Response Types

```typescript
// POST /api/process/start
interface StartProcessRequest {
  command: string;
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

interface StartProcessResponse {
  process: {
    id: string;
    pid?: number;
    command: string;
    status: ProcessStatus;
    startTime: string;
    sessionId?: string;
  };
}

// GET /api/process/list
interface ListProcessesResponse {
  processes: Array<{
    id: string;
    pid?: number;
    command: string;
    status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    sessionId?: string;
  }>;
}

// GET /api/process/{id}
interface GetProcessResponse {
  process: {
    id: string;
    pid?: number;
    command: string;
    status: ProcessStatus;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    sessionId?: string;
  } | null;
}

// GET /api/process/{id}/logs
interface GetProcessLogsResponse {
  stdout: string;
  stderr: string;
  processId: string;
}
```

## Main Sandbox Interface

### Complete Sandbox Class Interface

```typescript
interface ISandbox {
  // Enhanced execution API
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  
  // Background process management
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  listProcesses(): Promise<Process[]>;
  getProcess(id: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<number>;
  
  // Advanced streaming
  execStream(command: string, options?: StreamOptions): AsyncIterable<ExecEvent>;
  streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncIterable<LogEvent>;
  
  // Utility methods
  cleanupCompletedProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
}
```

## Usage Examples with Types

```typescript
// Simple execution
const result: ExecResult = await sandbox.exec('ls -la');

// Streaming execution with callbacks
const buildResult: ExecResult = await sandbox.exec('npm run build', {
  stream: true,
  onOutput: (stream: 'stdout' | 'stderr', data: string) => {
    console.log(`[${stream}] ${data}`);
  },
  timeout: 60000,
  signal: new AbortController().signal
});

// Background process
const server: Process = await sandbox.startProcess('node server.js', {
  processId: 'web-server',
  onExit: (code: number | null) => {
    console.log(`Server exited with code: ${code}`);
  }
});

// Process management
const processes: Process[] = await sandbox.listProcesses();
const serverProcess: Process | null = await sandbox.getProcess('web-server');
await sandbox.killProcess('web-server');

// Advanced streaming
for await (const event: ExecEvent of sandbox.execStream('npm test')) {
  switch (event.type) {
    case 'start':
      console.log(`Started: ${event.command}`);
      break;
    case 'stdout':
      process.stdout.write(event.data!);
      break;
    case 'complete':
      console.log(`Completed with exit code: ${event.exitCode}`);
      break;
  }
}

// Process log streaming
for await (const log: LogEvent of sandbox.streamProcessLogs('web-server')) {
  if (log.type === 'stdout') {
    console.log(`[${log.processId}] ${log.data}`);
  }
}
```

## Type Guards

```typescript
// Utility type guards for better type safety
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
```