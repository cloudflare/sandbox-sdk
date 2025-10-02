# API Reference

The Cloudflare Sandbox SDK provides a comprehensive API for running isolated code environments on Cloudflare's edge network. This reference documents all available methods, types, and interfaces.

## Core API

### Sandbox Class

The main `Sandbox` class provides all sandbox functionality through a unified interface.

#### `getSandbox(namespace, id)`

Creates or retrieves a sandbox instance.

```typescript
import { getSandbox } from "@cloudflare/sandbox";

const sandbox = getSandbox(env.Sandbox, "my-sandbox-id");
```

**Parameters:**
- `namespace: DurableObjectNamespace<Sandbox>` - The Durable Object namespace binding
- `id: string` - Unique identifier for the sandbox instance

**Returns:** `ISandbox` - Sandbox instance

---

## Command Execution

### `exec(command, options?)`

Execute a command and return the complete result.

```typescript
const result = await sandbox.exec("npm install express");
console.log(result.stdout, result.exitCode);

// With streaming callbacks
const result = await sandbox.exec("npm run build", {
  stream: true,
  onOutput: (stream, data) => console.log(`[${stream}] ${data}`)
});
```

**Parameters:**
- `command: string` - Command to execute
- `options?: ExecOptions` - Execution options

**Options:**
```typescript
interface ExecOptions {
  timeout?: number;                                    // Max execution time in ms
  env?: Record<string, string>;                       // Environment variables
  cwd?: string;                                       // Working directory
  encoding?: string;                                  // Text encoding (default: 'utf8')
  stream?: boolean;                                   // Enable real-time streaming
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;  // Output callback
  onComplete?: (result: ExecResult) => void;          // Completion callback
  onError?: (error: Error) => void;                   // Error callback
  signal?: AbortSignal;                               // Abort signal for cancellation
}
```

**Returns:** `Promise<ExecResult>`

```typescript
interface ExecResult {
  success: boolean;      // Whether command succeeded (exitCode === 0)
  exitCode: number;      // Process exit code
  stdout: string;        // Standard output content
  stderr: string;        // Standard error content
  command: string;       // Command that was executed
  duration: number;      // Execution duration in milliseconds
  timestamp: string;     // ISO timestamp when command started
}
```

### `execStream(command, options?)`

Execute a command and return a streaming response.

```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

const stream = await sandbox.execStream("npm run test");
for await (const event of parseSSEStream<ExecEvent>(stream)) {
  switch (event.type) {
    case 'stdout':
      console.log(`Output: ${event.data}`);
      break;
    case 'complete':
      console.log(`Exit code: ${event.exitCode}`);
      break;
  }
}
```

**Parameters:**
- `command: string` - Command to execute
- `options?: StreamOptions` - Streaming options

**Returns:** `Promise<ReadableStream<Uint8Array>>` - Server-Sent Events stream

---

## Process Management

### `startProcess(command, options?)`

Start a background process with lifecycle management.

```typescript
const process = await sandbox.startProcess("node server.js", {
  processId: "web-server",
  env: { PORT: "3000" },
  onOutput: (stream, data) => console.log(`Server: ${data}`)
});
```

**Parameters:**
- `command: string` - Command to execute
- `options?: ProcessOptions` - Process options

**Options:**
```typescript
interface ProcessOptions {
  processId?: string;                                 // Custom process ID
  timeout?: number;                                   // Max execution time in ms
  env?: Record<string, string>;                      // Environment variables
  cwd?: string;                                      // Working directory
  encoding?: string;                                 // Text encoding
  autoCleanup?: boolean;                             // Auto-cleanup on exit (default: true)
  onExit?: (code: number | null) => void;            // Exit callback
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;  // Output callback
  onStart?: (process: Process) => void;              // Start callback
  onError?: (error: Error) => void;                  // Error callback
}
```

**Returns:** `Promise<Process>`

```typescript
interface Process {
  readonly id: string;           // Unique process identifier
  readonly pid?: number;         // System process ID
  readonly command: string;      // Command that was executed
  readonly status: ProcessStatus; // Current process status
  readonly startTime: Date;      // When the process started
  readonly endTime?: Date;       // When the process ended
  readonly exitCode?: number;    // Process exit code
  
  kill(signal?: string): Promise<void>;              // Kill the process
  getStatus(): Promise<ProcessStatus>;               // Get current status
  getLogs(): Promise<{ stdout: string; stderr: string }>;  // Get accumulated logs
}

type ProcessStatus = 'starting' | 'running' | 'completed' | 'failed' | 'killed' | 'error';
```

### `listProcesses()`

List all running processes.

```typescript
const processes = await sandbox.listProcesses();
processes.forEach(proc => {
  console.log(`Process ${proc.id}: ${proc.status}`);
});
```

**Returns:** `Promise<Process[]>` - Array of process objects

### `getProcess(id)`

Get details for a specific process.

```typescript
const process = await sandbox.getProcess("web-server");
if (process) {
  console.log(`Status: ${process.status}`);
}
```

**Parameters:**
- `id: string` - Process ID

**Returns:** `Promise<Process | null>` - Process object or null if not found

### `killProcess(id, signal?)`

Terminate a specific process.

```typescript
await sandbox.killProcess("web-server", "SIGTERM");
```

**Parameters:**
- `id: string` - Process ID
- `signal?: string` - Signal to send (default: "SIGTERM")

### `killAllProcesses()`

Kill all running processes.

```typescript
const killedCount = await sandbox.killAllProcesses();
console.log(`Killed ${killedCount} processes`);
```

**Returns:** `Promise<number>` - Number of processes killed

### `streamProcessLogs(id, options?)`

Stream logs from a running process.

```typescript
const logStream = await sandbox.streamProcessLogs("web-server");
for await (const log of parseSSEStream<LogEvent>(logStream)) {
  console.log(`[${log.type}] ${log.data}`);
}
```

**Parameters:**
- `id: string` - Process ID
- `options?: { signal?: AbortSignal }` - Streaming options

**Returns:** `Promise<ReadableStream<Uint8Array>>` - Log stream

### `getProcessLogs(id)`

Get accumulated logs from a process.

```typescript
const logs = await sandbox.getProcessLogs("web-server");
console.log("Stdout:", logs.stdout);
console.log("Stderr:", logs.stderr);
```

**Parameters:**
- `id: string` - Process ID

**Returns:** `Promise<{ stdout: string; stderr: string }>` - Process logs

---

## File System Operations

### `writeFile(path, content, options?)`

Write content to a file.

```typescript
await sandbox.writeFile("/workspace/app.js", "console.log('Hello!');", {
  encoding: "utf8"
});
```

**Parameters:**
- `path: string` - File path
- `content: string` - File content
- `options?: { encoding?: string }` - Write options

**Returns:** `Promise<WriteFileResponse>`

### `readFile(path, options?)`

Read a file from the sandbox.

```typescript
const file = await sandbox.readFile("/package.json");
console.log(file.content);
```

**Parameters:**
- `path: string` - File path
- `options?: { encoding?: string }` - Read options

**Returns:** `Promise<ReadFileResponse>`

```typescript
interface ReadFileResponse {
  success: boolean;
  exitCode: number;
  path: string;
  content: string;
  timestamp: string;
}
```

### `deleteFile(path)`

Delete a file.

```typescript
await sandbox.deleteFile("/tmp/temp-file.txt");
```

**Parameters:**
- `path: string` - File path to delete

**Returns:** `Promise<DeleteFileResponse>`

### `renameFile(oldPath, newPath)`

Rename a file.

```typescript
await sandbox.renameFile("/old-name.txt", "/new-name.txt");
```

**Parameters:**
- `oldPath: string` - Current file path
- `newPath: string` - New file path

**Returns:** `Promise<RenameFileResponse>`

### `moveFile(sourcePath, destinationPath)`

Move a file to a different location.

```typescript
await sandbox.moveFile("/src/file.txt", "/dest/file.txt");
```

**Parameters:**
- `sourcePath: string` - Source file path
- `destinationPath: string` - Destination file path

**Returns:** `Promise<MoveFileResponse>`

### `mkdir(path, options?)`

Create a directory.

```typescript
await sandbox.mkdir("/workspace/new-dir", { recursive: true });
```

**Parameters:**
- `path: string` - Directory path
- `options?: { recursive?: boolean }` - Creation options

**Returns:** `Promise<MkdirResponse>`

### `listFiles(path, options?)`

List files in a directory.

```typescript
const listing = await sandbox.listFiles("/workspace", {
  recursive: true,
  includeHidden: false
});
```

**Parameters:**
- `path: string` - Directory path
- `options?: { recursive?: boolean; includeHidden?: boolean }` - Listing options

**Returns:** `Promise<ListFilesResponse>`

```typescript
interface ListFilesResponse {
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
```

### `gitCheckout(repoUrl, options)`

Clone a git repository.

```typescript
await sandbox.gitCheckout("https://github.com/user/repo", {
  branch: "main",
  targetDir: "/workspace/my-project"
});
```

**Parameters:**
- `repoUrl: string` - Git repository URL
- `options: { branch?: string; targetDir?: string }` - Checkout options

**Returns:** `Promise<GitCheckoutResponse>`

---

## Port Management

### `exposePort(port, options)`

Expose a port and get a public URL.

```typescript
const preview = await sandbox.exposePort(3000, {
  name: "web-server",
  hostname: "my-worker.dev"
});
console.log(`Available at: ${preview.url}`);
```

**Parameters:**
- `port: number` - Port number to expose
- `options: { name?: string; hostname: string }` - Exposure options

**Returns:** `Promise<{ url: string; port: number; name?: string }>`

### `unexposePort(port)`

Remove port exposure.

```typescript
await sandbox.unexposePort(3000);
```

**Parameters:**
- `port: number` - Port number to unexpose

### `getExposedPorts(hostname)`

List all exposed ports with their URLs.

```typescript
const ports = await sandbox.getExposedPorts("my-worker.dev");
ports.forEach(port => {
  console.log(`${port.name}: ${port.url}`);
});
```

**Parameters:**
- `hostname: string` - Hostname for URL construction

**Returns:** `Promise<Array<{ url: string; port: number; name?: string; exposedAt: string }>>`

---

## Environment Management

### `setEnvVars(envVars)`

Set environment variables dynamically in the sandbox.

> **Important**: Must be called immediately after `getSandbox()` and before any other operations.

```typescript
const sandbox = getSandbox(env.Sandbox, "my-sandbox");

// Set environment variables FIRST
await sandbox.setEnvVars({
  NODE_ENV: "production",
  API_KEY: "your-api-key"
});

// Now you can run commands
const result = await sandbox.exec("echo $NODE_ENV");
```

**Parameters:**
- `envVars: Record<string, string>` - Environment variables to set

---

## Code Interpreter

### `createCodeContext(options?)`

Create a new code execution context with persistent state.

```typescript
// Create a Python context
const pythonCtx = await sandbox.createCodeContext({ 
  language: 'python',
  cwd: '/workspace',
  envVars: { PYTHONPATH: '/custom/path' }
});

// Create a JavaScript context
const jsCtx = await sandbox.createCodeContext({ language: 'javascript' });
```

**Parameters:**
- `options?: CreateContextOptions` - Context creation options

**Options:**
```typescript
interface CreateContextOptions {
  language?: 'python' | 'javascript' | 'typescript';  // Programming language
  cwd?: string;                                        // Working directory
  envVars?: Record<string, string>;                   // Environment variables
}
```

**Returns:** `Promise<CodeContext>`

```typescript
interface CodeContext {
  id: string;              // Unique context identifier
  language: string;        // Programming language
  createdAt: string;       // Creation timestamp
}
```

### `runCode(code, options?)`

Execute code with optional streaming callbacks.

```typescript
// Simple execution
const execution = await sandbox.runCode('print("Hello World")', { 
  context: pythonCtx 
});

// With streaming callbacks
await sandbox.runCode(`
import time
for i in range(5):
    print(f"Step {i}")
    time.sleep(1)
`, { 
  context: pythonCtx,
  onStdout: (output) => console.log('Real-time:', output.text),
  onResult: (result) => {
    if (result.png) {
      console.log('Chart generated!');
    }
  }
});
```

**Parameters:**
- `code: string` - Code to execute
- `options?: RunCodeOptions` - Execution options

**Options:**
```typescript
interface RunCodeOptions {
  context?: CodeContext;                              // Context to run in
  language?: 'python' | 'javascript' | 'typescript'; // Language if no context
  onStdout?: (output: OutputMessage) => void;         // Stdout callback
  onStderr?: (output: OutputMessage) => void;         // Stderr callback
  onResult?: (result: Result) => void;                // Result callback
  onError?: (error: ExecutionError) => void;          // Error callback
}
```

**Returns:** `Promise<ExecutionResult>`

```typescript
interface ExecutionResult {
  success: boolean;        // Whether execution succeeded
  results: Result[];       // Array of execution results
  stdout: string;          // Standard output
  stderr: string;          // Standard error
  executionTime: number;   // Execution time in milliseconds
}

interface Result {
  text?: string;           // Plain text representation
  html?: string;           // HTML content (e.g., pandas DataFrames)
  png?: string;            // Base64 encoded PNG image
  jpeg?: string;           // Base64 encoded JPEG image
  svg?: string;            // SVG vector graphics
  json?: any;              // Structured JSON data
  chart?: ChartData;       // Parsed chart information
  
  formats(): string[];     // Get available format types
}
```

### `runCodeStream(code, options?)`

Execute code and return a streaming response.

```typescript
const stream = await sandbox.runCodeStream('import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.show()');
// Process the stream as needed
```

**Parameters:**
- `code: string` - Code to execute
- `options?: RunCodeOptions` - Execution options

**Returns:** `Promise<ReadableStream>` - Streaming response

### `listCodeContexts()`

List all active code contexts.

```typescript
const contexts = await sandbox.listCodeContexts();
contexts.forEach(ctx => {
  console.log(`Context ${ctx.id}: ${ctx.language}`);
});
```

**Returns:** `Promise<CodeContext[]>` - Array of active contexts

### `deleteCodeContext(contextId)`

Delete a specific code context.

```typescript
await sandbox.deleteCodeContext(pythonCtx.id);
```

**Parameters:**
- `contextId: string` - Context ID to delete

---

## Session Management

### `createSession(options)`

Create an isolated execution session within the sandbox.

```typescript
const buildSession = await sandbox.createSession({
  id: "build-session",
  env: { NODE_ENV: "production" },
  cwd: "/build",
  isolation: true
});

// Sessions have full ISandbox interface
await buildSession.exec("npm run build");
```

**Parameters:**
- `options: SessionOptions` - Session configuration

**Options:**
```typescript
interface SessionOptions {
  id?: string;                         // Session identifier (auto-generated if not provided)
  env?: Record<string, string>;        // Environment variables
  cwd?: string;                        // Working directory
  isolation?: boolean;                 // Enable PID namespace isolation
}
```

**Returns:** `Promise<ExecutionSession>` - Session object with full ISandbox interface

---

## Streaming Utilities

### `parseSSEStream<T>(stream)`

Convert a ReadableStream to a typed AsyncIterable for Server-Sent Events.

```typescript
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';

const stream = await sandbox.execStream('npm run build');
for await (const event of parseSSEStream<ExecEvent>(stream)) {
  console.log(`Event: ${event.type}`);
}
```

**Parameters:**
- `stream: ReadableStream<Uint8Array>` - SSE stream to parse

**Returns:** `AsyncIterable<T>` - Typed async iterable

### `responseToAsyncIterable<T>(response)`

Convert an SSE Response directly to AsyncIterable.

```typescript
import { responseToAsyncIterable } from '@cloudflare/sandbox';

const response = await fetch('/api/stream');
for await (const event of responseToAsyncIterable<ExecEvent>(response)) {
  console.log(event);
}
```

### `asyncIterableToSSEStream<T>(iterable)`

Convert an AsyncIterable back to an SSE stream.

```typescript
import { asyncIterableToSSEStream } from '@cloudflare/sandbox';

async function* generateEvents() {
  yield { type: 'start', data: 'Beginning process...' };
  yield { type: 'complete', data: 'Process finished' };
}

const stream = asyncIterableToSSEStream(generateEvents());
```

---

## Request Handler Utilities

### `proxyToSandbox(request, env)`

Proxy requests to exposed container ports via preview URLs.

```typescript
import { proxyToSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request, env) {
    // Route requests to exposed container ports
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    // Your custom routes here
    return new Response("Not found", { status: 404 });
  },
};
```

**Parameters:**
- `request: Request` - Incoming request
- `env: SandboxEnv` - Environment with Sandbox binding

**Returns:** `Promise<Response | null>` - Proxied response or null if not a sandbox URL

---

## Error Types

### `SandboxError`

Base error class for sandbox operations.

```typescript
class SandboxError extends Error {
  constructor(message: string, public code?: string)
}
```

### `CodeExecutionError`

Error during code execution.

### `ContainerNotReadyError`

Container is not ready for operations.

### `ContextNotFoundError`

Code context not found.

### `JupyterNotReadyError`

Jupyter kernel not ready.

### `ServiceUnavailableError`

Service temporarily unavailable.

### `SandboxNetworkError`

Network-related sandbox error.

---

## Event Types

### `ExecEvent`

Events emitted during command execution streaming.

```typescript
interface ExecEvent {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  result?: ExecResult;
  error?: string;
}
```

### `LogEvent`

Events emitted during process log streaming.

```typescript
interface LogEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  timestamp: string;
  data: string;
  processId: string;
  exitCode?: number;
}
```

---

## Type Guards

### `isExecResult(value)`

Check if a value is a valid ExecResult.

### `isProcess(value)`

Check if a value is a valid Process object.

### `isProcessStatus(value)`

Check if a string is a valid ProcessStatus.

---

## Security Features

The SDK includes built-in security features:

- **Container Isolation**: Each sandbox runs in its own Docker container with process isolation
- **Port Validation**: Exposed ports are validated to only allow non-system ports (1024-65535), excluding reserved ports (3000, 8787)
- **Sandbox ID Sanitization**: Sandbox IDs are validated for DNS compliance (1-63 chars, no leading/trailing hyphens, no reserved names)
- **Execution Timeouts**: Commands timeout after 30 seconds by default (configurable via `COMMAND_TIMEOUT_MS`)
- **Security Event Logging**: Security events are logged with severity levels for monitoring
- **Temp File Cleanup**: Temporary files are cleaned up after 60 seconds

**Note**: The SDK does not enforce CPU or memory limits directly - these would be enforced at the Cloudflare platform level (Containers/Durable Objects). File path sanitization against directory traversal is not implemented in the current SDK version.
