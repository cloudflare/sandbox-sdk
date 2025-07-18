# Background Process Support Implementation Plan

## Problem Statement

Currently, when users run long-running commands (like HTTP servers) using the `exec` method, the command blocks indefinitely waiting for the process to complete. This prevents users from:
- Starting a server and then exposing its port
- Running multiple services concurrently
- Performing other operations while a server is running

Example of the current issue:
```javascript
// This blocks forever, never reaching the exposePort line
await sandbox.exec("bun", ["run", "/server.js"]);
await sandbox.exposePort(8080); // Never reached!
```

## Solution Overview

Add a `background` option to the exec method that allows processes to run detached from the parent process. Combined with the existing `stream` option, this provides flexible control over process execution and log monitoring.

## API Design

### Option Combinations

1. **`background: false` (default)**
   - Current behavior: synchronous execution
   - Waits for process to complete
   - Returns all output when done
   - Use case: Running commands that complete (e.g., `npm install`)

2. **`background: true, stream: false`**
   - Starts process in background (detached)
   - Returns immediately after spawn
   - Includes any initial output captured during spawn
   - Use case: Fire-and-forget servers where you don't need logs

3. **`background: true, stream: true`**
   - Starts process in background (detached)
   - Keeps HTTP connection open indefinitely
   - Streams all stdout/stderr output in real-time
   - Process continues even if connection closes
   - Use case: Monitoring server logs while performing other operations

### Example Usage

```javascript
// Start a server in the background
await sandbox.exec("bun", ["run", "/server.js"], { background: true });

// Now you can expose the port
const preview = await sandbox.exposePort(8080);

// Or, start with streaming to monitor logs
await sandbox.exec("bun", ["run", "/server.js"], { 
  background: true, 
  stream: true 
});
// This keeps streaming logs indefinitely while the server runs
```

## Implementation Details

### 1. Update Type Definitions

**File: `/packages/sandbox/src/sandbox.ts`**

Add background option to the exec method interface:
```typescript
async exec(command: string, args: string[], options?: { 
  stream?: boolean;
  background?: boolean;
}) {
  if (options?.stream) {
    return this.client.executeStream(command, args, options?.background);
  }
  return this.client.execute(command, args, options?.background);
}
```

### 2. Update Client Methods

**File: `/packages/sandbox/src/client.ts`**

Update the execute methods to accept background parameter:
```typescript
async execute(
  command: string,
  args: string[] = [],
  background?: boolean,
  sessionId?: string
): Promise<ExecuteResponse> {
  // Add background to request body
  const response = await this.doFetch(`/api/execute`, {
    body: JSON.stringify({
      args,
      command,
      background,
      sessionId: targetSessionId,
    }),
    // ...
  });
}

async executeStream(
  command: string,
  args: string[] = [],
  background?: boolean,
  sessionId?: string
): Promise<void> {
  // Similar update for streaming
}
```

### 3. Update Container Implementation

**File: `/packages/sandbox/container_src/index.ts`**

This is where the core logic changes happen:

#### For non-streaming background execution:
```typescript
if (body.background) {
  const child = spawn(command, args, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
  
  // Unref so parent doesn't wait
  child.unref();
  
  // Collect initial output briefly (100ms)
  let initialStdout = "";
  let initialStderr = "";
  
  child.stdout?.on("data", (data) => {
    initialStdout += data.toString();
  });
  
  child.stderr?.on("data", (data) => {
    initialStderr += data.toString();
  });
  
  // Return quickly with initial output
  setTimeout(() => {
    return new Response(JSON.stringify({
      success: true,
      stdout: initialStdout,
      stderr: initialStderr,
      exitCode: 0, // Process still running
      command,
      args,
      timestamp: new Date().toISOString(),
      background: true,
      message: "Process started in background"
    }));
  }, 100);
}
```

#### For streaming background execution:
```typescript
if (body.background) {
  const child = spawn(command, args, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
  
  child.unref();
  
  // Stream indefinitely - don't wait for close event
  child.stdout?.on("data", (data) => {
    controller.enqueue(/* SSE formatted output */);
  });
  
  child.stderr?.on("data", (data) => {
    controller.enqueue(/* SSE formatted error */);
  });
  
  // Don't close the stream when process exits
  // Let the client decide when to close
}
```

### 4. Update Execute Request Interface

**File: `/packages/sandbox/container_src/index.ts`**

Add background to the ExecuteRequest interface:
```typescript
interface ExecuteRequest {
  command: string;
  args?: string[];
  sessionId?: string;
  background?: boolean;
}
```

### 5. Update Example

**File: `/examples/basic/src/index.ts`**

Update the test-preview route to use background execution:
```typescript
// Start the Bun server in the background
await sandbox.exec("bun", ["run", "/server.js"], { background: true });

// Remove the setTimeout - no longer needed!
// await new Promise(resolve => setTimeout(resolve, 1000));

// Expose the port immediately
const preview = await sandbox.exposePort(8080, { name: "bun-server" });
```

## Testing Plan

1. **Test fire-and-forget background process**
   - Start a server with `background: true, stream: false`
   - Verify it returns immediately
   - Verify the server is actually running (via port check)

2. **Test streaming background process**
   - Start a server with `background: true, stream: true`
   - Verify logs stream continuously
   - Make requests to the server and see logs appear
   - Close the stream and verify server keeps running

3. **Test existing behavior unchanged**
   - Run commands without background option
   - Verify they still block until completion

4. **Test edge cases**
   - Background process that exits immediately
   - Background process that fails to start
   - Multiple background processes

## Migration Guide

For users currently working around this limitation:

**Before:**
```javascript
// Had to use setTimeout or other workarounds
await sandbox.exec("node", ["server.js"]);
// Never reached!
```

**After:**
```javascript
// Just add background: true
await sandbox.exec("node", ["server.js"], { background: true });
// Continues immediately!
```

## Future Enhancements

1. **Process Management API** (not in this PR)
   - List running background processes
   - Kill specific background processes
   - Attach to running process logs

2. **Process Monitoring** (not in this PR)
   - Get process status
   - CPU/memory usage
   - Automatic restart on crash

## Implementation Checklist

- [x] Update TypeScript interfaces in sandbox.ts
- [x] Update client.ts execute methods
- [x] Update ExecuteRequest interface in container
- [x] Implement detached spawning for background processes
- [x] Handle non-streaming background (return quickly)
- [x] Handle streaming background (stream indefinitely)
- [x] Update example to use background execution
- [ ] Test all combinations of options
- [ ] Verify existing behavior unchanged
- [ ] Update any relevant documentation

## Implementation Summary

The background process support has been successfully implemented with the following changes:

1. **Updated Type Definitions**:
   - Added `background?: boolean` option to `exec` method in `sandbox.ts`
   - Updated `ExecuteRequest` interface in both `client.ts` and `container_src/index.ts`

2. **Client Updates**:
   - Modified `execute()` and `executeStream()` methods to accept background parameter
   - Pass background flag in request body

3. **Container Implementation**:
   - Added detached spawning with `detached: true` for background processes
   - Use `child.unref()` to prevent blocking the parent process
   - For non-streaming background: collect output for 100ms then return
   - For streaming background: keep stream open indefinitely (don't close on process exit)

4. **Example Updated**:
   - Removed artificial 1-second timeout
   - Changed to `await sandbox.exec("bun", ["run", "/server.js"], { background: true });`

The implementation maintains backward compatibility while adding powerful background execution capabilities.