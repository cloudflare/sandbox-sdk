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

### Phase 1: Core API Implementation ✅ COMPLETED
- [x] **New exec() method** - Enhanced with streaming callbacks, always returns ExecResult
  - [x] Update exec() signature with new options (stream, onOutput, signal, timeout)
  - [x] Ensure exec() always returns ExecResult regardless of streaming
  - [x] Add callback-based streaming support
  - [x] Add AbortSignal and timeout support
- [x] **startProcess() method** - Background process management
  - [x] Implement startProcess() with Process return type
  - [x] Add process ID generation and tracking
  - [x] Add process status management (starting, running, completed, etc.)
- [x] **Process management methods**
  - [x] listProcesses() - List active processes
  - [x] getProcess(id) - Get process status by ID
  - [x] killProcess(id) - Terminate process
  - [x] killAllProcesses() - Terminate all processes
  - [x] getProcessLogs(id) - Get accumulated process logs
- [x] **AsyncIterable streaming methods**
  - [x] execStream() - Advanced streaming for commands
  - [x] streamProcessLogs() - Stream logs from background processes

### Phase 2: Container Implementation ✅ COMPLETED
- [x] **New container endpoints**
  - [x] POST /api/process/start - Start background process
  - [x] GET /api/process/list - List processes 
  - [x] GET /api/process/{id} - Get process status
  - [x] DELETE /api/process/{id} - Kill process
  - [x] DELETE /api/process/all - Kill all processes
  - [x] GET /api/process/{id}/logs - Get accumulated logs
  - [x] GET /api/process/{id}/stream - Stream process output (SSE)
- [x] **Process storage and management**
  - [x] In-memory process registry (Map<string, ProcessRecord>)
  - [x] Process lifecycle tracking with real Node.js ChildProcess
  - [x] Output accumulation and streaming
  - [x] Cleanup on process exit with automatic listeners
- [x] **HttpClient integration**
  - [x] All new process management methods implemented
  - [x] Type-safe request/response handling
  - [x] ReadableStream support for log streaming

### Phase 3: Enhanced Features 🔄 IN PROGRESS
- [x] **Advanced options and error handling**
  - [x] Environment variable support (env option)
  - [x] Working directory support (cwd option)  
  - [x] Text encoding support (encoding option)
  - [x] Timeout support (timeout option)
  - [x] Enhanced error reporting (custom error classes)
  - [ ] Resource limits and constraints (memory/CPU limits)
  - [ ] Advanced signal handling (beyond basic kill)
- [ ] **Process cleanup enhancements**
  - [ ] cleanupCompletedProcesses() endpoint implementation
  - [ ] Auto-cleanup configuration per process
  - [ ] Graceful shutdown handling (SIGTERM support)
- [ ] **Testing and validation**
  - [ ] Unit tests for all new APIs
  - [ ] Integration tests for process management  
  - [ ] Performance and memory leak testing
  - [ ] Container restart behavior validation
  - [ ] Error edge case testing (crashes, timeouts, OOM)

### Phase 4: Documentation and Migration ⏸️ PENDING
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
3. ✅ Implement Phase 1 (Core API Implementation) - **COMPLETED**
4. ✅ Implement Phase 2 (Container Implementation) - **COMPLETED**
5. 🚀 **CURRENT FOCUS**: Complete Phase 3 (Enhanced Features)
   - [ ] Add missing container endpoint for cleanup
   - [ ] Build comprehensive test suite
   - [ ] Add resource limits and advanced error handling
6. Create migration documentation and examples
7. Gather feedback from early adopters

## Current Implementation Status 

### ✅ What's Complete (Phases 1 & 2)
- **Full API Implementation**: All new methods (exec, startProcess, execStream, etc.) 
- **Container Endpoints**: Complete HTTP API for process management
- **Type Safety**: Comprehensive TypeScript definitions
- **Process Management**: Real ChildProcess integration with lifecycle tracking
- **Streaming**: Both callback-based and AsyncIterable patterns
- **Error Handling**: Custom error classes and proper error propagation
- **Options Support**: Environment variables, working directory, timeout, encoding

### ⚠️ Implementation Gaps Identified

**Critical Gaps (should be addressed soon):**
1. **No Tests**: Zero test coverage for the new APIs
2. **Missing Cleanup Endpoint**: `cleanupCompletedProcesses()` not implemented in container
3. **Signal Support Limited**: Only basic kill, no SIGTERM/SIGINT support
4. **No Resource Limits**: No memory/CPU constraints on processes
5. **No Container Restart Handling**: Unclear behavior when container restarts

**Documentation Gaps:**
6. **No Migration Guide**: Developers don't know how to move from old API
7. **No Usage Examples**: Missing practical examples and best practices
8. **No Performance Characteristics**: Unknown memory usage, limits, etc.

**Nice-to-Have Gaps:**
9. **No Performance Testing**: Untested with many concurrent processes
10. **No Monitoring**: No metrics or observability for process management
11. **No Inter-Process Communication**: No helpers for processes to communicate

### 🎯 Recommended Next Actions

**High Priority (Address Soon):**
1. **Add Basic Testing** - At least integration tests for core functionality
2. **Implement Cleanup Endpoint** - Add `POST /api/process/cleanup` to container
3. **Create Usage Examples** - Show developers how to use the new APIs
4. **Test Edge Cases** - Process crashes, timeouts, memory exhaustion

**Medium Priority (Next Phase):**
5. **Add Resource Limits** - Memory and CPU constraints per process  
6. **Enhanced Signal Support** - Proper SIGTERM handling with grace periods
7. **Migration Documentation** - Guide for moving from old exec() API
8. **Performance Testing** - Load testing with many processes

**Lower Priority (Future Enhancement):**
9. **Advanced Monitoring** - Process metrics and health checks
10. **Container Restart Recovery** - Graceful handling of container restarts
11. **Inter-Process Helpers** - Communication primitives between processes

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

## Architecture Summary

### System Architecture (As Implemented)

```
┌─────────────────┐    HTTP    ┌──────────────────┐    Node.js     ┌─────────────────┐
│   Sandbox       │ ---------> │  Container       │ ChildProcess   │  User Processes │
│   Class         │            │  HTTP Server     │ ------------> │  (node, npm,    │
│  (sandbox.ts)   │            │ (index.ts:3000)  │               │   python, etc.) │
└─────────────────┘            └──────────────────┘               └─────────────────┘
         │                              │                                    │
         │                              │                                    │
    ┌─────────┐                  ┌─────────────┐                      ┌─────────────┐
    │HttpClient│                  │Process Store│                      │   Output    │
    │(client.ts)│                  │  (in-memory)│                      │ Streaming   │
    └─────────┘                  └─────────────┘                      └─────────────┘
```

### Data Flow
1. **Sandbox.startProcess()** → **HttpClient.startProcess()** → **POST /api/process/start**
2. **Container** spawns real **ChildProcess** and stores in **Map<string, ProcessRecord>**
3. **Process output** captured and streamed via **Server-Sent Events**
4. **Process lifecycle** tracked (starting → running → completed/failed/killed)
5. **Auto-cleanup** on process exit, manual cleanup via **DELETE /api/process/cleanup**

### Key Achievements
- ✅ **Complete API Redesign** - From confusing single method to clear, purpose-built methods
- ✅ **Real Process Management** - Actual ChildProcess spawning, not fake timeouts
- ✅ **Type-Safe Architecture** - Full TypeScript integration across all layers
- ✅ **Modern Streaming** - Both callback and AsyncIterable patterns supported
- ✅ **Container Integration** - Real HTTP endpoints with proper lifecycle management
- ✅ **Error Handling** - Custom error classes and proper error propagation
- ✅ **Resource Cleanup** - Automatic process cleanup and proper resource management

The implementation successfully transforms the Sandbox SDK from a basic command executor into a full-featured process management platform suitable for complex development workflows.