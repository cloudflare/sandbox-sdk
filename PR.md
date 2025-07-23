# Cloudflare Sandbox SDK - Major Refactor with Beautiful AsyncIterable APIs ✨

This PR implements a comprehensive refactor of the Cloudflare Sandbox SDK, introducing beautiful AsyncIterable streaming APIs, robust process management, and a production-ready architecture that developers will love.

## 🚀 Major Highlights

### Beautiful AsyncIterable Streaming APIs
Transform clunky `ReadableStream<Uint8Array>` handling into elegant `for await` loops:

```typescript
// ❌ OLD: Manual stream parsing nightmare
const stream = await sandbox.execStream('npm build');
const reader = stream.getReader();
const decoder = new TextDecoder();
// ... 20+ lines of manual SSE parsing ...

// ✅ NEW: Beautiful AsyncIterable API
for await (const event of sandbox.execStream('npm build')) {
  switch (event.type) {
    case 'stdout':
      console.log(`Build: ${event.data}`);
      break;
    case 'complete':
      console.log(`Exit code: ${event.exitCode}`);
      break;
  }
}
```

## Key Changes

### 1. AsyncIterable Streaming Implementation
- **Created SSE parser utility** (`sse-parser.ts`) for robust Server-Sent Events parsing
- **Updated ISandbox interface** to return `AsyncIterable<ExecEvent>` and `AsyncIterable<LogEvent>`
- **Converted methods to async generators** - `execStream` and `streamProcessLogs` now yield typed events
- **Full cancellation support** via AbortSignal
- **Graceful error handling** with typed error events

### 2. API Redesign & Legacy Cleanup
- **Removed legacy `execLegacy` method** - Cleaned up deprecated implementation
- **Removed `background` parameter** from all execution methods
- **Clear method separation**:
  - `exec()` - Synchronous command execution with optional callbacks
  - `execStream()` - Async streaming via AsyncIterable
  - `startProcess()` - Background process management
  - `streamProcessLogs()` - Real-time process log streaming

### 3. Real Process Management
- **Actual process lifecycle tracking** with real ChildProcess management
- **Comprehensive process APIs**:
  - `listProcesses()` - View all running processes
  - `getProcess(id)` - Get detailed process status
  - `killProcess(id)` - Terminate specific processes
  - `streamProcessLogs(id)` - Stream logs via AsyncIterable
  - `getProcessLogs(id)` - Get accumulated output

### 4. Type System Enhancements
- **Rich event types** for streaming:
  ```typescript
  interface ExecEvent {
    type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
    timestamp: string;
    data?: string;
    exitCode?: number;
    // ... more fields
  }
  ```
- **Full TypeScript support** with proper type inference
- **Type guards** for runtime validation

### 5. Example App Updates
- **Updated to use AsyncIterable APIs** throughout
- **Simplified streaming implementation** - Removed manual SSE parsing
- **Beautiful code examples** demonstrating best practices

## Breaking Changes

### 1. Streaming Method Signatures
```typescript
// ❌ OLD
execStream(command: string): Promise<ReadableStream<Uint8Array>>
streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>

// ✅ NEW
execStream(command: string): AsyncIterable<ExecEvent>
streamProcessLogs(id: string): AsyncIterable<LogEvent>
```

### 2. Removed `background` Option
```typescript
// ❌ OLD
await sandbox.exec('node server.js', { background: true });

// ✅ NEW
const process = await sandbox.startProcess('node server.js');
```

### 3. Legacy Method Removal
- `execLegacy()` has been completely removed
- All references to background execution in `exec()` removed

## Usage Examples

### CI/CD Build System
```typescript
export async function runBuild(env: Env, buildId: string) {
  const sandbox = getSandbox(env.SANDBOX, buildId);

  for await (const event of sandbox.execStream('npm run build')) {
    switch (event.type) {
      case 'start':
        await env.BUILDS.put(buildId, { status: 'running' });
        break;
      case 'stdout':
        await env.BUILD_LOGS.append(buildId, event.data);
        break;
      case 'complete':
        await env.BUILDS.put(buildId, {
          status: event.exitCode === 0 ? 'success' : 'failed',
          exitCode: event.exitCode
        });
        break;
    }
  }
}
```

### System Monitoring
```typescript
const monitor = await sandbox.startProcess('tail -f /var/log/system.log');

for await (const log of sandbox.streamProcessLogs(monitor.id)) {
  if (log.type === 'stdout' && log.data.includes('ERROR')) {
    await env.ALERTS.send({
      severity: 'high',
      message: log.data,
      timestamp: log.timestamp
    });
  }
}
```

### Worker with Frontend SSE
```typescript
app.get('/api/build/stream', async (req, env) => {
  const sandbox = getSandbox(env.SANDBOX, 'builder');
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        for await (const event of sandbox.execStream('make build')) {
          const sse = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(sse));
        }
        controller.close();
      }
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
});
```

## Technical Architecture

### Durable Object Compatibility
- AsyncIterables cannot cross RPC boundaries, so we:
  1. Return `ReadableStream<Uint8Array>` from container
  2. Parse SSE within the Durable Object
  3. Yield typed events from async generators
  4. This maintains the beautiful API while working within platform constraints

### SSE Parser
- Robust handling of chunked data
- Graceful error recovery for malformed events
- Proper buffer management for incomplete events
- Full UTF-8 support with streaming decoder

## Testing & Documentation

### Test Coverage
- Created comprehensive streaming tests (`streaming.test.ts`)
- Tests for pure Worker usage (no frontend)
- Concurrent stream handling tests
- Cancellation and error handling tests

### Documentation Updates
- Updated README with AsyncIterable examples
- Added usage patterns for various scenarios
- Migration guide for breaking changes
- Complete API reference

## Migration Guide

1. **Update streaming code**:
   ```typescript
   // Before
   const stream = await sandbox.execStream(cmd);
   const reader = stream.getReader();
   // ... manual parsing ...

   // After
   for await (const event of sandbox.execStream(cmd)) {
     console.log(event);
   }
   ```

2. **Replace background execution**:
   ```typescript
   // Before
   await sandbox.exec(cmd, { background: true });

   // After
   await sandbox.startProcess(cmd);
   ```

3. **Update error handling**:
   ```typescript
   try {
     for await (const event of sandbox.execStream(cmd)) {
       // Process events
     }
   } catch (error) {
     // Errors throw normally now
   }
   ```

## Future Enhancements

- WebSocket support for bidirectional streaming
- Stream composition utilities
- Backpressure handling for high-volume streams
- Stream transformation pipelines

---

This PR delivers on the promise of beautiful, modern JavaScript APIs for the Cloudflare Sandbox SDK. The AsyncIterable pattern makes streaming a joy to work with, while maintaining full compatibility with the Cloudflare platform.

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>