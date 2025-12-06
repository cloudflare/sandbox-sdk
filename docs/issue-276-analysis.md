# Issue #276: Parallel Code Context Operations Crash Container

## Problem Summary

When creating multiple code execution contexts in parallel, the container can crash or return 500 errors. The issue was discovered during PR #266 refactoring, where parallel context creation/deletion caused permanent test timeouts.

## Root Cause

**Location**: `packages/sandbox-container/src/runtime/process-pool.ts:612`

The bug is in the `reserveExecutorForContext()` method:

```typescript
async reserveExecutorForContext(contextId: string, language: InterpreterLanguage) {
  const mutex = this.poolLocks.get(language)!;
  await mutex.runExclusive(async () => {
    // ...
    if (available.length > 0) {
      executor = available.shift()!;
    } else {
      // BUG: createProcess() is awaited INSIDE the mutex!
      executor = await this.createProcess(language, contextId);  // Line 612
    }
    // ...
  });
}
```

### The Problem

1. **Mutex Held During Slow Operation**: The per-language mutex is held while `createProcess()` spawns a child process and waits for it to emit a "ready" signal
2. **Serial Execution**: This forces all context creation for a language to happen serially, even when requested in parallel
3. **Timeouts Cascade**: If one process spawn is slow (can take seconds), all queued requests wait, potentially timing out

### Why It Causes Crashes

- **Scenario**: 5 contexts created in parallel for Python
- **Current Behavior**:
  - Context 1: Waits 0s for mutex, spawns process (3s)
  - Context 2: Waits 3s for mutex, spawns process (3s)
  - Context 3: Waits 6s for mutex, spawns process (3s)
  - Context 4: Waits 9s for mutex, spawns process (3s)
  - Context 5: Waits 12s for mutex, spawns process (3s)
  - **Total time**: 15 seconds for what should be concurrent
- **Expected Behavior**: All 5 processes spawn concurrently (~3s total)

The timeout for process spawn is `CONFIG.INTERPRETER_SPAWN_TIMEOUT_MS`. If this is reached, the request fails with a 500 error.

## Evidence

1. **Test Behavior**:
   - Parallel context operations → timeouts/500 errors
   - Sequential context operations → works fine

2. **Intermittent Failures**:
   - Issue is intermittent because it depends on system load
   - First run might fail, subsequent runs succeed (processes already spawned)

3. **Code Analysis**:
   - Pre-warming creates 3 executors per language at startup
   - When > 3 parallel requests arrive, new processes must be spawned
   - Each spawn holds the mutex for ~2-3 seconds

## Potential Solutions

### Option 1: Release Mutex During Process Creation (RECOMMENDED)

Move process creation outside the mutex:

```typescript
async reserveExecutorForContext(contextId: string, language: InterpreterLanguage) {
  const mutex = this.poolLocks.get(language)!;

  // Check availability under mutex
  const shouldCreate = await mutex.runExclusive(async () => {
    const available = this.availableExecutors.get(language) || [];
    if (available.length > 0) {
      const executor = available.shift()!;
      this.availableExecutors.set(language, available);
      this.contextExecutors.set(contextId, executor);
      executor.sessionId = contextId;
      return false; // Don't need to create
    }
    return true; // Need to create
  });

  if (shouldCreate) {
    // Create process OUTSIDE mutex - allows parallelism
    const executor = await this.createProcess(language, contextId);

    // Then add to tracking under mutex
    await mutex.runExclusive(async () => {
      const pool = this.pools.get(language)!;
      pool.push(executor);
      executor.sessionId = contextId;
      this.contextExecutors.set(contextId, executor);
    });
  }
}
```

**Pros**:
- Allows parallel process creation
- Minimal code changes
- Preserves thread safety for data structures

**Cons**:
- Slightly more complex logic
- Race condition: Two requests might both decide to create when only one is needed
  (Not a problem - extra process gets added to available pool)

### Option 2: Async Queue for Process Creation

Use a separate queue for process creation requests:

```typescript
private createQueue: Map<InterpreterLanguage, Promise<InterpreterProcess>[]> = new Map();

async reserveExecutorForContext(contextId: string, language: InterpreterLanguage) {
  const mutex = this.poolLocks.get(language)!;
  return await mutex.runExclusive(async () => {
    const available = this.availableExecutors.get(language) || [];

    if (available.length > 0) {
      const executor = available.shift()!;
      // ... assign and return
    } else {
      // Check if creation already in progress
      const queue = this.createQueue.get(language) || [];
      if (queue.length > 0) {
        // Wait for an in-flight creation
        const executor = await queue[0];
        // Try again (might be available now)
        return this.reserveExecutorForContext(contextId, language);
      } else {
        // Start new creation
        const createPromise = this.createProcess(language, contextId);
        queue.push(createPromise);
        this.createQueue.set(language, queue);

        try {
          const executor = await createPromise;
          return executor;
        } finally {
          // Remove from queue when done
          const idx = queue.indexOf(createPromise);
          if (idx > -1) queue.splice(idx, 1);
        }
      }
    }
  });
}
```

**Pros**:
- Avoids creating unnecessary processes
- More sophisticated resource management

**Cons**:
- Much more complex
- Recursive retry logic
- Harder to reason about

### Option 3: Increase Pre-warming Pool Size

Simply increase the minimum pool size to handle typical parallelism:

```typescript
const DEFAULT_EXECUTOR_CONFIGS = {
  python: {
    minSize: 10,  // Increased from 3
    // ...
  }
};
```

**Pros**:
- Simple one-line change
- Handles common cases

**Cons**:
- Wastes resources (idle processes)
- Doesn't solve the fundamental issue
- Still fails under high load

## Recommended Approach

**Implement Option 1** with these additions:

1. Release mutex during process creation
2. Add tracking for "in-flight" process creations to avoid over-creating
3. Keep comprehensive debug logging to monitor behavior
4. Consider increasing pre-warm pool size slightly (3 → 5) as a safety net

## Testing Plan

1. Run new test: `tests/e2e/parallel-context-crash.test.ts`
   - 5 parallel context creations
   - 5 parallel context deletions
   - Mixed create/delete operations

2. Monitor debug logs for:
   - Mutex wait times
   - Process creation times
   - Total reservation times

3. Verify under load:
   - Deploy to test worker with `SANDBOX_LOG_LEVEL=debug`
   - Run parallel tests
   - Confirm no 500 errors
   - Confirm reasonable timing (<5s total for 5 contexts)

## Related Code

- `packages/sandbox-container/src/runtime/process-pool.ts:560-640` - reserveExecutorForContext()
- `packages/sandbox-container/src/runtime/process-pool.ts:326-504` - createProcess()
- `packages/sandbox-container/src/services/interpreter-service.ts:96-187` - createContext()
- `tests/e2e/code-interpreter-workflow.test.ts:330-336` - Parallel cleanup (works)
- `tests/e2e/code-interpreter-workflow.test.ts:361-363` - Sequential creation (current)
