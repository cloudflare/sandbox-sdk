# Fix Streaming Architecture: Preserve Beautiful APIs with Durable Object Compatibility

## 🚨 **The Problem**

The beautiful AsyncIterable streaming APIs envisioned in `APPROACHES.md` don't work across Durable Object RPC boundaries due to serialization constraints.

### **Failing Pattern**
```typescript
// This beautiful code doesn't work 💔
for await (const log of sandbox.streamProcessLogs('process-id')) {
  console.log(log.data);
}

// Error: "sandbox.streamProcessLogs(...) is not a function or its return value is not async iterable"
```

### **Root Cause: Serialization Boundary**

When calling methods on Durable Object stubs:
1. **Arguments serialized** → transmitted to DO
2. **Method executes** in DO context 
3. **Return value serialized** → transmitted back

**What Works** ✅:
- `Promise<ExecResult>` → JSON serializable
- `Promise<Process[]>` → Array of objects
- `Response` objects → HTTP streaming responses

**What Fails** ❌:
- `AsyncIterable<LogEvent>` → **Stateful streaming object, cannot serialize**

AsyncIterables have internal state, ongoing execution context, and iterator protocols that cannot be pickled and transmitted across process boundaries.

## 🎯 **The Solution: HTTP-Backed AsyncIterables**

### **Preserve Beautiful Public APIs** 
Developers still write this exact code:
```typescript
// Beautiful API remains unchanged ✨
for await (const event of sandbox.streamProcessLogs(processId)) {
  console.log(`[${event.type}] ${event.data}`);
}

for await (const event of sandbox.execStream('npm run build')) {
  if (event.type === 'stdout') {
    process.stdout.write(event.data);
  }
}
```

### **Current Infrastructure is Already Correct! ✅**

The existing infrastructure already works perfectly:

```typescript
// HttpClient.streamProcessLogs() - ALREADY CORRECT
async streamProcessLogs(processId: string): Promise<ReadableStream<Uint8Array>> {
  const response = await this.doFetch(`/api/process/${processId}/stream`, {
    headers: { "Accept": "text/event-stream" },
    method: "GET",
  });
  return response.body; // ReadableStream from container
}

// HttpClient.doFetch() - ALREADY USES containerFetch!
private async doFetch(path: string, options?: RequestInit): Promise<Response> {
  if (this.options.stub) {
    response = await this.options.stub.containerFetch(url, options, this.options.port);
  }
  // ... 
}
```

**The infrastructure flow is perfect:**
1. `Sandbox.streamProcessLogs()` → `HttpClient.streamProcessLogs()` 
2. `HttpClient.doFetch()` → `Sandbox.containerFetch()` → Container process
3. Container returns SSE Response → HttpClient returns ReadableStream ✅

**The ONLY issue:** AsyncIterable cannot be returned across RPC boundary.

## 🏗️ **Technical Architecture**

### **Current (Working) Infrastructure**
```
Worker → sandbox.streamProcessLogs() [RPC] → DO → HttpClient.doFetch() → containerFetch() → Container process ✅
```

### **The Actual Problem**
```
Container → ReadableStream ✅ → HttpClient ✅ → Sandbox method converts to AsyncIterable ✅ → RPC boundary ❌
```

### **Current Implementation Flow (All Working Except Last Step)**
```
1. Worker calls sandbox.streamProcessLogs() [RPC to Durable Object]
2. Sandbox DO calls this.client.streamProcessLogs() [method call]
3. HttpClient calls this.doFetch('/api/process/{id}/stream') [internal method] 
4. doFetch calls this.options.stub.containerFetch() [same Sandbox DO]
5. containerFetch makes request to Container process on port 3000 [HTTP request]
6. Container returns SSE Response stream [HTTP response] ✅
7. HttpClient returns response.body (ReadableStream) [return value] ✅
8. Sandbox method converts to AsyncIterable ✅
9. ❌ FAILS: Cannot serialize AsyncIterable across RPC boundary
```

## 🔧 **Implementation Strategy**

### **Option 1: Return ReadableStream Instead of AsyncIterable (Simplest)**

Since the infrastructure already works perfectly, we can just return the ReadableStream:

```typescript
// Current (fails at RPC boundary):
async *streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): AsyncIterable<LogEvent> {
  const stream = await this.client.streamProcessLogs(processId);
  // Convert to AsyncIterable - fails at RPC boundary
}

// Fixed (serializable):
async streamProcessLogs(processId: string, options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
  return await this.client.streamProcessLogs(processId); // Already works perfectly!
}
```

### **Option 2: Keep AsyncIterable API - Handle Conversion in Worker**

If we want to preserve the beautiful AsyncIterable API, handle the conversion in the Worker:

```typescript
// In Sandbox DO - return Response instead of AsyncIterable
async getProcessLogStream(processId: string): Promise<Response> {
  const stream = await this.client.streamProcessLogs(processId);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

// In Worker - convert Response to AsyncIterable for frontend
async *streamProcessLogs(processId: string): AsyncIterable<LogEvent> {
  const response = await sandbox.getProcessLogStream(processId);
  yield* parseServerSentEvents(response.body!);
}
```

### **Option 3: Hybrid Approach - Best of Both Worlds**

Return Response from DO, convert to AsyncIterable where needed:

```typescript
// In Sandbox DO - return serializable Response
async getProcessLogStream(processId: string): Promise<Response> {
  const stream = await this.client.streamProcessLogs(processId);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

// Helper method for convenience - can be used by Worker
static async *streamToAsyncIterable<T>(response: Response): AsyncIterable<T> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            yield JSON.parse(line.substring(6)) as T;
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### **Recommended Approach: Option 1 (Simplest)**

Since the infrastructure already works perfectly, the simplest fix is to return `ReadableStream` instead of `AsyncIterable` from the DO methods. The Worker can convert to AsyncIterable if needed for the frontend.

## ✅ **Benefits of This Approach**

### **1. Preserves Beautiful APIs**
```typescript
// Developers still write this exact code ✨
for await (const log of sandbox.streamProcessLogs('my-process')) {
  console.log(log.data);
}
```

### **2. Solves Durable Object Constraints**
- Uses HTTP streaming (serializable)
- Iterator state remains in DO context
- Only individual events cross RPC boundary

### **3. Maintains APPROACHES.md Vision**
All the beautiful examples still work:
```typescript
// 🌊 Modern streaming for build tools
for await (const event of sandbox.execStream('npm run build')) {
  switch (event.type) {
    case 'stdout': process.stdout.write(event.data); break;
    case 'complete': return event.result;
  }
}

// 🔍 Log monitoring  
for await (const log of sandbox.streamProcessLogs('log-monitor')) {
  if (log.data.includes('ERROR')) {
    await alertSystem(log.data);
  }
}
```

### **4. Production Ready**
- Proper error handling and timeouts
- Cancellation via AbortSignal
- Resource cleanup and memory management
- Compatible with Worker/Durable Object lifecycle

### **5. Future Proof**
- Extensible pattern for new streaming features
- Clear separation between public API and internal implementation
- Easy to optimize performance without API changes

## 🚀 **Implementation Plan**

### **Phase 1: Simple Fix (1-2 days)**
- [ ] Change `streamProcessLogs()` return type from `AsyncIterable<LogEvent>` to `Promise<ReadableStream<Uint8Array>>`
- [ ] Change `execStream()` return type from `AsyncIterable<ExecEvent>` to `Promise<ReadableStream<Uint8Array>>`  
- [ ] Update Worker to handle ReadableStream → SSE conversion
- [ ] Test that streaming works across DO boundaries

### **Phase 2: Enhanced API (Optional - 1 week)**
- [ ] Add convenience methods like `getProcessLogStream()` that return Response objects
- [ ] Create helper utilities for ReadableStream → AsyncIterable conversion
- [ ] Update Worker to provide AsyncIterable APIs for frontend if desired
- [ ] Performance testing and optimization

### **Phase 3: Documentation & Polish (Few days)**  
- [ ] Update `APPROACHES.md` with final implementation patterns
- [ ] Update type definitions and interfaces
- [ ] Update example app if needed
- [ ] Add migration guide if any breaking changes

## 🎯 **Success Criteria**

When this is complete:

✅ **Streaming Works**: No more "is not a function or its return value is not async iterable" errors  
✅ **Durable Object Compatible**: ReadableStream serializes correctly across RPC boundaries  
✅ **Infrastructure Preserved**: All existing HttpClient → containerFetch infrastructure continues working  
✅ **Worker Streaming**: Worker can convert ReadableStream to SSE for frontend  
✅ **Minimal Changes**: Simple return type changes, no architectural overhaul needed

## 💡 **Key Insights Discovered**

1. **Infrastructure was already correct** - HttpClient → doFetch → containerFetch → Container was working perfectly
2. **AsyncIterable serialization is the only issue** - everything else worked fine
3. **ReadableStream is serializable** - much simpler solution than expected
4. **Containers package is well-designed** - leveraging existing patterns is the right approach  
5. **Simple fixes are often better** - changing return types vs rebuilding architecture

This approach gives us: **working streaming with minimal code changes** and **preservation of all existing infrastructure**.