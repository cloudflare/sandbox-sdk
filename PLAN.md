# Sandbox SDK Execution API Redesign Plan

## Current State Analysis

### Existing `exec()` Method Issues

The current `exec(command, args, options)` method has two options:
- `stream?: boolean` - Changes return type completely (`ExecuteResponse` vs `void`)
- `background?: boolean` - Changes execution semantics dramatically

**Problems Identified:**

1. **Inconsistent API**: Same method signature produces fundamentally different behaviors and return types
2. **Confusing semantics**: `background: true` with `stream: false` returns fake success after 100ms
3. **Missing lifecycle management**: No way to check status, get real exit codes, or manage background processes
4. **Resource leaks**: Background + streaming keeps connections open indefinitely
5. **Poor discoverability**: Options interact in non-obvious ways

### Current Implementation Behavior

| stream | background | Behavior |
|--------|------------|----------|
| false  | false      | ✅ Synchronous execution, returns complete result |
| false  | true       | ❌ Returns fake success after 100ms, process continues |
| true   | false      | ✅ Streams output, closes when complete |
| true   | true       | ⚠️ Streams output, keeps connection open indefinitely |

## Cloudflare Context & Opportunities

### Built on @cloudflare/containers
Our sandbox extends `Container` from `@cloudflare/containers`, which provides:
- **Durable Object persistence** - API state and metadata survive across invocations
- **Activity-based lifecycle** - Auto-cleanup via `sleepAfter` timeout
- **Web-native patterns** - HTTP/WebSocket/SSE support built-in
- **Container lifecycle hooks** - `onStart`, `onStop`, `onError` integration

### Critical Container Platform Behavior
**Resource Limits:**
- **Instance types**: dev (256MB), basic (1GB), standard (4GB)
- **Account limits**: 40GB memory, 20 vCPU, 100GB disk total
- **Image limits**: 2GB per image, 50GB total storage

**Lifecycle Management:**
- **Shutdown process**: SIGTERM → 15min wait → SIGKILL
- **Container restarts**: Host servers restart irregularly but frequently
- **Ephemeral disk**: Fresh filesystem on every restart
- **OOM behavior**: Automatic restart on memory exhaustion
- **Cold starts**: Typically 2-3 seconds

**Deployment & Scaling:**
- **Rolling deploys**: Worker code updates immediately, container rolls out gradually (25% batches)
- **Manual scaling**: No autoscaling yet (beta limitation)
- **Geographic placement**: Containers may start far from user if closer locations busy

### This Enables New Possibilities
1. **Ephemeral process management** - Background processes run within single container lifecycle
2. **Natural web streams** - ReadableStream, SSE, WebSocket support built-in
3. **Automatic resource cleanup** - Container restart completely cleans up processes
4. **Simple lifecycle model** - No cross-restart complexity to handle
5. **Graceful shutdown handling** - 15-minute SIGTERM window for process cleanup

## API Design Approaches Under Consideration

### Approach 1: Two-Method + Web Streams
Focus on simplicity with modern web platform APIs:

```typescript
class Sandbox {
  // Primary execution API - consistent return type
  async exec(command: string, args: string[], options?: {
    stream?: boolean,                    // Enable real-time callbacks
    onOutput?: (stream, data) => void,   // Simple callback pattern
    signal?: AbortSignal,               // Web standard cancellation
    timeout?: number,
  }): Promise<ExecResult>                // ALWAYS returns result

  // Background processes with native streaming
  async startProcess(command: string, args: string[], options?: ProcessOptions): Promise<{
    process: Process,
    logStream: ReadableStream<LogEvent>  // Web Streams API
  }>

  // Process management
  async listProcesses(): Promise<Process[]>
  async getProcess(id: string): Promise<Process | null>
  async killProcess(id: string): Promise<void>
}
```

**Pros**: Simple discovery, consistent returns, web-native
**Cons**: ReadableStream might be overkill for simple use cases

### Approach 2: AsyncIterable + DO Metadata
Leverage modern JavaScript patterns with Durable Object metadata storage:

```typescript
class Sandbox {
  // Simple execution
  async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
  
  // Modern streaming execution
  async *execStream(command: string, args: string[], options?: StreamOptions): AsyncIterable<ExecEvent>
  
  // Background processes with ephemeral state
  async startProcess(command: string, args: string[], options?: ProcessOptions): Promise<Process>
  
  // Stream logs from active processes
  async *streamProcessLogs(processId: string): AsyncIterable<LogEvent>
}
```

**Pros**: Very clean, composable, leverages DO for metadata tracking
**Cons**: AsyncIterable less familiar to some developers

### Approach 3: Single Method + Explicit Modes
Keep single entry point with clear mode specification:

```typescript
class Sandbox {
  async exec(command: string, args: string[], options?: {
    mode: 'sync' | 'stream' | 'background',
    onOutput?: (stream, data) => void,
    signal?: AbortSignal,
  }): Promise<ExecResult | Process>  // Type unions based on mode

  // Separate process management
  async *streamProcessLogs(id: string): AsyncIterable<LogEvent>
}
```

**Pros**: Single method to learn
**Cons**: Return type varies by mode, type safety challenges

## Streaming Pattern Considerations

### Callback vs AsyncIterable vs WebStreams
- **Callbacks**: Simple, familiar, but not composable
- **AsyncIterable**: Clean, modern, great for sequential processing
- **WebStreams**: Native web platform, excellent for complex streaming
- **Server-Sent Events**: Perfect for web clients, auto-reconnection

### Background Process Log Access
Key requirement: Stream logs from active background processes within container lifecycle.

**Options considered**:
1. `process.streamLogs()` - Method on Process object
2. `sandbox.streamProcessLogs(id)` - Sandbox-level method  
3. `process.logEventSource` - SSE EventSource property
4. Hybrid approach with multiple access patterns

### 2. Clear Type Definitions

```typescript
// Base execution options
interface BaseExecOptions {
  sessionId?: string;
  timeout?: number;          // Max execution time
  env?: Record<string, string>;
  cwd?: string;
  encoding?: string;
}

// Synchronous execution
interface ExecOptions extends BaseExecOptions {
  // No additional options needed
}

interface ExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  args: string[];
  duration: number;
  timestamp: string;
}

// Streaming execution  
interface StreamOptions extends BaseExecOptions {
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
  onComplete?: (result: ExecResult) => void;
  onError?: (error: string) => void;
}

// Background process management
interface ProcessOptions extends BaseExecOptions {
  processId?: string;        // Custom ID for later reference
  autoCleanup?: boolean;     // Auto-cleanup after exit (default: true)
  onExit?: (code: number) => void;
}

interface Process {
  id: string;
  pid?: number;              // System process ID if available
  command: string;
  args: string[];
  status: 'starting' | 'running' | 'completed' | 'failed' | 'killed';
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  
  // Management methods
  kill(signal?: string): Promise<void>;
  getStatus(): Promise<ProcessStatus>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
}

// Background service with streaming
interface ServiceOptions extends ProcessOptions {
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
  healthCheck?: {
    port?: number;
    path?: string;
    interval?: number;
  };
}

interface Service extends Process {
  // Additional service-specific methods
  streamOutput(): AsyncIterable<OutputEvent>;
  getHealth(): Promise<ServiceHealth>;
}
```

### 3. Process Management API

```typescript
class Sandbox {
  // Process lifecycle management
  async listProcesses(): Promise<Process[]>
  async getProcess(id: string): Promise<Process | null>
  async killProcess(id: string, signal?: string): Promise<void>
  async killAllProcesses(): Promise<void>
  
  // Bulk operations
  async cleanupCompletedProcesses(): Promise<number>
  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>
}
```

### 4. Container Implementation Changes

**New endpoints needed:**
- `POST /api/process/start` - Start background process
- `POST /api/service/start` - Start background service with streaming
- `GET /api/process/list` - List all processes
- `GET /api/process/{id}` - Get process status
- `DELETE /api/process/{id}` - Kill process
- `GET /api/process/{id}/logs` - Get process logs
- `GET /api/process/{id}/stream` - Stream process output

**Process storage (in-memory only):**
```typescript
interface ProcessRecord {
  id: string;
  pid?: number;
  command: string;
  args: string[];
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  sessionId?: string;
  childProcess?: ChildProcess;  // Active process reference
  stdout: string;               // Accumulated output (ephemeral)
  stderr: string;               // Accumulated output (ephemeral)
}

// Ephemeral - cleared on container restart
const processes = new Map<string, ProcessRecord>();
```

## Migration Strategy

### Phase 1: Add New APIs (Non-breaking)
1. Implement new methods alongside existing `exec()`
2. Add container endpoints for process management
3. Add comprehensive tests
4. Update documentation

### Phase 2: Deprecation Period
1. Mark old `exec()` method as deprecated
2. Provide migration guide
3. Add runtime warnings for problematic option combinations
4. Update examples to use new APIs

### Phase 3: Breaking Change (Major Version)
1. Remove old `exec()` method
2. Clean up deprecated code paths
3. Optimize implementation without backward compatibility

## Benefits of New Design

### ✅ Clarity
- Each method has a single, clear purpose
- No confusing option interactions
- Predictable return types and behavior

### ✅ Functionality
- Proper background process management
- Real exit codes and lifecycle events
- Resource cleanup and limits
- Streaming without resource leaks

### ✅ Discoverability
- Method names indicate intended use case
- TypeScript provides better autocomplete and validation
- Fewer runtime surprises

### ✅ Extensibility
- Easy to add new options without breaking existing code
- Process management can evolve independently
- Service-specific features (health checks, etc.)

## Implementation Priorities

### High Priority (Core Functionality)
1. `exec()` - Basic synchronous execution
2. `execStream()` - Streaming execution  
3. `startProcess()` - Background process management
4. Process management endpoints in container

### Medium Priority (Enhanced Features)
5. `startService()` - Background services with streaming
6. Process lifecycle events and callbacks
7. Resource limits and timeouts
8. Bulk process operations

### Low Priority (Nice to Have)
9. Health check integration for services
10. Process metrics and monitoring
11. Advanced logging and output handling
12. Inter-process communication helpers

## Open Questions & Decisions Needed

### API Design Decisions
1. **Method count vs discoverability**: Two methods (`exec` + `startProcess`) vs three (`exec` + `execStream` + `startProcess`) vs one with modes?
2. **Streaming pattern**: AsyncIterable vs WebStreams vs Callbacks vs hybrid?
3. **Background log access**: Multiple patterns or single approach?
4. **Return type consistency**: Should all execution methods return results, even streaming ones?

### Cloudflare Integration Questions  
5. **Container lifecycle**: Background processes must handle SIGTERM (15min cleanup window)
6. **Activity timeout**: Background processes should call `renewActivityTimeout()` to prevent container sleep
7. **Port management**: Integration with existing `exposePort`/`unexposePort` methods?
8. **Resource constraints**: How to enforce limits within 256MB-4GB container instances?

### Implementation Questions
9. **Process isolation**: Security boundaries between processes within same container?
10. **Session management**: Should sessions own their processes within container lifecycle?
11. **Error handling**: Distinguish container OOM/restart from process failures
12. **Graceful shutdown**: How to ensure background processes respect SIGTERM cleanup window?

## Current Thinking & Preferences

Based on our discussion:

### Leaning Toward: Two-Method Approach + AsyncIterable
```typescript
class Sandbox {
  // 90% use case - consistent, simple
  async exec(cmd, args, { stream?, onOutput?, ... }): Promise<ExecResult>
  
  // 10% use case - background processes  
  async startProcess(cmd, args, options): Promise<Process>
  
  // Modern streaming for both
  async *execStream(cmd, args): AsyncIterable<ExecEvent>
  async *streamProcessLogs(id: string): AsyncIterable<LogEvent>
}
```

**Rationale**:
- **Discoverability**: Most devs start with `exec()`
- **Consistency**: `exec()` always returns `ExecResult`, streaming just adds callbacks
- **Modern**: AsyncIterables for advanced streaming use cases
- **Platform-appropriate**: Simple ephemeral process model matches container lifecycle

### Key Insights from Discussion
1. **Fixed streaming return type**: `exec({ stream: true })` should still return `ExecResult`
2. **Background process log access**: Critical requirement, AsyncIterable fits well
3. **Web platform patterns**: AbortSignal, ReadableStream, AsyncIterable over callbacks
4. **Ephemeral processes**: Container restarts provide natural cleanup, simplifying design

## Implementation Tracking

### Phase 1: Core API Implementation ✅ Ready to Start
- [ ] **New exec() method** - Enhanced with streaming callbacks, always returns ExecResult
  - [ ] Update exec() signature with new options (stream, onOutput, signal, timeout)
  - [ ] Ensure exec() always returns ExecResult regardless of streaming
  - [ ] Add callback-based streaming support
  - [ ] Add AbortSignal and timeout support
- [ ] **startProcess() method** - Background process management
  - [ ] Implement startProcess() with Process return type
  - [ ] Add process ID generation and tracking
  - [ ] Add process status management (starting, running, completed, etc.)
- [ ] **Process management methods**
  - [ ] listProcesses() - List active processes
  - [ ] getProcess(id) - Get process status by ID
  - [ ] killProcess(id) - Terminate process
- [ ] **AsyncIterable streaming methods**
  - [ ] execStream() - Advanced streaming for commands
  - [ ] streamProcessLogs() - Stream logs from background processes

### Phase 2: Container Implementation
- [ ] **New container endpoints**
  - [ ] POST /api/process/start - Start background process
  - [ ] GET /api/process/list - List processes 
  - [ ] GET /api/process/{id} - Get process status
  - [ ] DELETE /api/process/{id} - Kill process
  - [ ] GET /api/process/{id}/logs - Get accumulated logs
  - [ ] GET /api/process/{id}/stream - Stream process output (SSE)
- [ ] **Process storage and management**
  - [ ] In-memory process registry (Map<string, ProcessRecord>)
  - [ ] Process lifecycle tracking
  - [ ] Output accumulation and streaming
  - [ ] Cleanup on process exit

### Phase 3: Enhanced Features  
- [ ] **Advanced options and error handling**
  - [ ] Environment variable support
  - [ ] Working directory support
  - [ ] Resource limits and constraints
  - [ ] Enhanced error reporting
- [ ] **Testing and validation**
  - [ ] Unit tests for all new APIs
  - [ ] Integration tests for process management
  - [ ] Performance and memory leak testing
  - [ ] Container restart behavior validation

### Phase 4: Documentation and Migration
- [ ] **Developer documentation**
  - [ ] API reference updates
  - [ ] Migration guide from old API
  - [ ] Usage examples and best practices
  - [ ] Troubleshooting guide
- [ ] **Deprecation and cleanup**
  - [ ] Mark old exec() as deprecated
  - [ ] Add migration warnings
  - [ ] Plan breaking change timeline

## Next Steps

1. ✅ Review and iterate on this plan until satisfied - **COMPLETED**
2. ✅ Create detailed API specifications - **COMPLETED in APPROACHES.md**
3. 🚀 **READY TO START**: Implement Phase 1 (new APIs) without breaking changes
4. Build comprehensive test suite 
5. Create migration documentation
6. Gather feedback from early adopters

## Implementation Notes

### Decision: Final API Signature
Based on comprehensive analysis in APPROACHES.md, we're implementing:

```typescript
class Sandbox {
  // Enhanced exec - always returns result, streaming via callbacks
  async exec(command: string, args: string[], options?: {
    stream?: boolean;
    onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
  }): Promise<ExecResult>

  // Background process management
  async startProcess(command: string, args: string[], options?: ProcessOptions): Promise<Process>
  
  // Modern streaming
  async *execStream(command: string, args: string[]): AsyncIterable<ExecEvent>
  async *streamProcessLogs(processId: string): AsyncIterable<LogEvent>
  
  // Process management
  async listProcesses(): Promise<Process[]>
  async getProcess(id: string): Promise<Process | null>
  async killProcess(id: string): Promise<void>
}
```

### Key Implementation Principles
1. **Backwards compatibility**: New methods alongside existing exec()
2. **Type safety**: No union types, predictable returns
3. **Resource management**: Proper cleanup and lifecycle tracking
4. **Modern patterns**: AbortSignal, AsyncIterable, Promise-based
5. **Ephemeral by design**: Process state resets on container restart