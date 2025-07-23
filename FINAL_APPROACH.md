# Final Approach: Beautiful AsyncIterable Streaming APIs

## Executive Summary

We're transforming the Cloudflare Sandbox SDK's streaming APIs from low-level `ReadableStream<Uint8Array>` to beautiful, typed `AsyncIterable` interfaces. This change delivers the developer experience originally envisioned in APPROACHES.md, making the SDK a joy to use for both frontend and backend scenarios.

**Key Achievement**: Developers will write clean `for await` loops with typed events instead of manually parsing byte streams.

## 🎯 Current State vs Target State

### Current State (Poor Developer Experience)
```typescript
// SDK returns raw byte streams
const stream: ReadableStream<Uint8Array> = await sandbox.execStream('npm build');

// Developers must manually parse SSE events
const reader = stream.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  // Manual SSE parsing with buffer management... 😭
}
```

### Target State (Beautiful APIs)
```typescript
// SDK returns typed AsyncIterable
for await (const event of sandbox.execStream('npm build')) {
  switch (event.type) {
    case 'stdout':
      console.log(`Build output: ${event.data}`);
      break;
    case 'complete':
      console.log(`Build finished with exit code: ${event.exitCode}`);
      break;
  }
}

// Process monitoring is equally elegant
for await (const log of sandbox.streamProcessLogs('web-server')) {
  if (log.type === 'stderr' && log.data.includes('ERROR')) {
    await handleError(log);
  }
}
```

## 📋 Implementation Plan

### Phase 1: Foundation
- [ ] **Create SSE Parser Utility** (`packages/sandbox/src/sse-parser.ts`)
  - Generic async generator: `parseSSEStream<T>(stream: ReadableStream): AsyncIterable<T>`
  - Handle buffering for incomplete SSE events
  - Parse JSON data with error recovery
  - Support abort signals for cancellation

- [ ] **Define Event Types** (`packages/sandbox/src/types.ts`)
  ```typescript
  interface ExecEvent {
    type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
    data?: string;
    command?: string;
    exitCode?: number;
    result?: ExecResult;
    timestamp: string;
  }
  
  interface LogEvent {
    type: 'stdout' | 'stderr' | 'exit' | 'error';
    data: string;
    timestamp: string;
    processId: string;
  }
  ```

### Phase 2: SDK Updates
- [ ] **Update ISandbox Interface** (`packages/sandbox/src/types.ts`)
  ```typescript
  interface ISandbox {
    // Change from: Promise<ReadableStream<Uint8Array>>
    // To: AsyncIterable<ExecEvent>
    execStream(command: string, options?: StreamOptions): AsyncIterable<ExecEvent>;
    
    // Change from: Promise<ReadableStream<Uint8Array>>  
    // To: AsyncIterable<LogEvent>
    streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncIterable<LogEvent>;
  }
  ```

- [ ] **Update Sandbox Implementation** (`packages/sandbox/src/sandbox.ts`)
  ```typescript
  async *execStream(command: string, options?: StreamOptions): AsyncIterable<ExecEvent> {
    const response = await this.containerFetch('/api/execute/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ command, sessionId: options?.sessionId })
    });

    if (!response.ok) {
      throw new Error(`Execute stream failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming execution');
    }

    yield* parseSSEStream<ExecEvent>(response.body, options?.signal);
  }

  async *streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncIterable<LogEvent> {
    const stream = await this.client.streamProcessLogs(processId);
    yield* parseSSEStream<LogEvent>(stream, options?.signal);
  }
  ```

### Phase 3: Testing & Examples
- [ ] **Create Pure Worker Tests** (`packages/sandbox/tests/streaming.test.ts`)
  - Test AsyncIterable consumption without any frontend
  - Verify type safety and event structure
  - Test error handling and cancellation

- [ ] **Update Example App** (`examples/basic/`)
  - Update Worker endpoints to use AsyncIterable APIs
  - Remove SSE parsing from frontend (SandboxApiClient)
  - Simplify streaming implementation

### Phase 4: Documentation
- [ ] **Update README** with AsyncIterable examples
- [ ] **Create Migration Guide** for updating from ReadableStream to AsyncIterable
- [ ] **Update APPROACHES.md** to mark AsyncIterable approach as implemented

## 🚀 Usage Examples

### Backend-Only Use Cases (No Frontend)

```typescript
// Worker monitoring system logs
export default {
  async scheduled(controller: ScheduledController, env: Env) {
    const sandbox = getSandbox(env.SANDBOX);
    
    // Start log monitor
    const monitor = await sandbox.startProcess('journalctl -f');
    
    // Process logs with AsyncIterable
    for await (const log of sandbox.streamProcessLogs(monitor.id)) {
      if (log.type === 'stdout') {
        // Check for critical errors
        if (log.data.includes('CRITICAL') || log.data.includes('FATAL')) {
          await env.ALERTS.send({
            severity: 'critical',
            message: log.data,
            timestamp: log.timestamp
          });
        }
        
        // Store in durable storage
        await env.LOGS.put(`${log.timestamp}-${monitor.id}`, log.data);
      }
    }
  }
}
```

### Build System Integration

```typescript
// Worker handling CI/CD builds
export async function runBuild(env: Env, buildId: string) {
  const sandbox = getSandbox(env.SANDBOX);
  const buildLog: string[] = [];
  
  // Stream build output with typed events
  for await (const event of sandbox.execStream('npm run build')) {
    switch (event.type) {
      case 'start':
        await env.BUILDS.put(buildId, { 
          status: 'running', 
          startTime: event.timestamp 
        });
        break;
        
      case 'stdout':
      case 'stderr':
        buildLog.push(`[${event.type}] ${event.data}`);
        // Send progress to websocket clients if needed
        break;
        
      case 'complete':
        await env.BUILDS.put(buildId, {
          status: event.exitCode === 0 ? 'success' : 'failed',
          exitCode: event.exitCode,
          logs: buildLog.join('\n'),
          endTime: event.timestamp
        });
        break;
        
      case 'error':
        await env.BUILDS.put(buildId, {
          status: 'error',
          error: event.data,
          logs: buildLog.join('\n')
        });
        break;
    }
  }
}
```

### Worker with Frontend (SSE Endpoint)

```typescript
// Worker endpoint streaming to frontend
app.get('/api/process/:id/stream', async (req, env) => {
  const sandbox = getSandbox(env.SANDBOX);
  const encoder = new TextEncoder();
  
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          // Beautiful AsyncIterable consumption
          for await (const log of sandbox.streamProcessLogs(req.params.id)) {
            // Forward typed events to frontend via SSE
            const sseEvent = `data: ${JSON.stringify(log)}\n\n`;
            controller.enqueue(encoder.encode(sseEvent));
          }
        } catch (error) {
          // Send error event
          const errorEvent = `data: ${JSON.stringify({ 
            type: 'error', 
            data: error.message 
          })}\n\n`;
          controller.enqueue(encoder.encode(errorEvent));
        } finally {
          controller.close();
        }
      }
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    }
  );
});
```

## 💥 Breaking Changes

### Method Signature Changes
1. **`execStream()`**
   - Before: `Promise<ReadableStream<Uint8Array>>`
   - After: `AsyncIterable<ExecEvent>`

2. **`streamProcessLogs()`**
   - Before: `Promise<ReadableStream<Uint8Array>>`
   - After: `AsyncIterable<LogEvent>`

### Required Code Updates
```typescript
// ❌ Old way (won't work anymore)
const stream = await sandbox.execStream('ls -la');
const reader = stream.getReader();
// ... manual parsing ...

// ✅ New way (much simpler!)
for await (const event of sandbox.execStream('ls -la')) {
  console.log(event);
}
```

## 🧪 Testing Strategy

### Unit Tests
- [ ] SSE parser handles incomplete chunks correctly
- [ ] Malformed JSON events are skipped gracefully
- [ ] Abort signals cancel iteration properly
- [ ] Memory is cleaned up after iteration completes

### Integration Tests
- [ ] Long-running processes stream output correctly
- [ ] Multiple concurrent streams work independently
- [ ] Process termination closes streams cleanly
- [ ] Error events are properly typed and delivered

### Example App Tests
- [ ] Commands tab uses new AsyncIterable API
- [ ] Streaming tab demonstrates proper patterns
- [ ] Process logs stream with correct types
- [ ] Frontend receives properly formatted events

## 📈 Migration Guide

### For SDK Users

1. **Update your imports** (no change needed - same SDK package)

2. **Update streaming code**:
   ```typescript
   // Before: Manual ReadableStream handling
   const stream = await sandbox.execStream(command);
   const reader = stream.getReader();
   const decoder = new TextDecoder();
   // ... lots of manual parsing code ...
   
   // After: Clean AsyncIterable
   for await (const event of sandbox.execStream(command)) {
     // Handle typed events directly
   }
   ```

3. **Update error handling**:
   ```typescript
   try {
     for await (const event of sandbox.execStream(command)) {
       // Process events
     }
   } catch (error) {
     // Errors are thrown normally, not sent as events
   }
   ```

### For Frontend Developers

If you have a frontend consuming Worker endpoints:
1. Worker endpoints now send properly typed JSON events
2. Remove any SSE parsing logic from your frontend
3. Events arrive pre-parsed and typed

## 🎯 Success Criteria

- [ ] Developers can use `for await` loops with full TypeScript support
- [ ] No manual SSE parsing required anywhere in user code
- [ ] Example app demonstrates best practices for both patterns
- [ ] All tests pass with the new AsyncIterable implementation
- [ ] Documentation clearly shows the beautiful new APIs

## 📅 Timeline

1. **Week 1**: Implement SSE parser and update types
2. **Week 1-2**: Update SDK methods to async generators
3. **Week 2**: Test with pure Worker scenarios
4. **Week 2-3**: Update example app and documentation
5. **Week 3**: Final testing and release

---

This approach delivers on the original vision from APPROACHES.md while working within the constraints of the Cloudflare platform. The result is a SDK that's a joy to use, with modern JavaScript patterns that developers expect.