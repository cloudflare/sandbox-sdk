# Concurrency Model

This document explains how concurrency and parallelism work at each layer of the Sandbox SDK. Understanding this is critical for contributors to avoid race conditions and write correct code.

## Overview: The Concurrency Stack

Requests flow through multiple layers, each with different concurrency characteristics:

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Cloudflare Workers                                    │
│  Single-threaded event loop, requests can interleave at await   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  Layer 2: Durable Object (Sandbox)                              │
│  Single instance globally, input/output gates protect storage   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  Layer 3: Container HTTP Server (Bun)                           │
│  Single-threaded event loop, concurrent request handling        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│  Layer 4: Shell Execution                                       │
│  True parallelism - separate OS processes                       │
└─────────────────────────────────────────────────────────────────┘
```

## Layer 1: Cloudflare Workers

### How It Works

Workers run in V8 isolates with a **single-threaded event loop**. A single Worker instance can handle multiple concurrent requests, but only one piece of JavaScript executes at any moment. Requests interleave at `await` points.

From the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/reference/how-workers-works/):

> "Like all other JavaScript platforms, a single Workers instance may handle multiple requests including concurrent requests in a single-threaded event loop. That means that other requests may (or may not) be processed during awaiting any async tasks."

### Why It Matters

- There's **no guarantee** two requests hit the same Worker instance
- Global state should **never** be mutated (Cloudflare explicitly warns against this)
- In our SDK, Workers are mostly pass-through to the DO, so risk is low

## Layer 2: Durable Objects

This is the most nuanced layer and where most confusion occurs.

### Single-Threaded, Single Instance

Each Durable Object ID has **exactly one active instance** globally. From the [Cloudflare blog post "Durable Objects: Easy, Fast, Correct — Choose three"](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/):

> "Each Durable Object runs in exactly one location, in one single thread, at a time."

This eliminates traditional multi-threading race conditions, but async/await creates opportunities for interleaving.

### Input Gates: Storage Operations Are Protected

The Cloudflare runtime uses **input gates** to prevent race conditions during storage operations. From the [Durable Objects documentation](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/):

> "While a storage operation is executing, no events shall be delivered to the object except for storage completion events."

This means:

```javascript
// SAFE: Input gates protect this
async increment() {
  const value = await this.ctx.storage.get("count");
  // No other request can execute here - input gate blocks
  await this.ctx.storage.put("count", value + 1);
}
```

**Why it's safe**: While `storage.get()` or `storage.put()` is in progress, incoming requests are queued. The runtime guarantees sequential execution through storage operations.

### Non-Storage I/O Allows Interleaving

**Critical**: Input gates only protect storage operations. Other async operations like `fetch()` allow interleaving:

```javascript
// POTENTIALLY UNSAFE: fetch() allows interleaving
async processItem(id) {
  const item = await this.ctx.storage.get(`item:${id}`);

  if (item?.status === "pending") {
    // During this fetch, OTHER REQUESTS CAN EXECUTE
    const result = await fetch("https://api.example.com/process");

    // Another request may have already modified this item!
    await this.ctx.storage.put(`item:${id}`, { status: "completed" });
  }
}
```

From the [Cloudflare documentation](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/):

> "Non-storage I/O like `fetch()` or writing to R2 allows other requests to interleave, which can cause race conditions."

### Output Gates: Responses Wait for Writes

Output gates ensure clients don't see confirmation before data is persisted. From the [blog post](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/):

> "When a storage write operation is in progress, any new outgoing network messages will be held back until the write has completed."

This means you can skip `await` on writes without risking data loss - if the write fails, the response is never sent.

### What This Means for the Sandbox DO

When `sandbox.exec()` calls `await this.containerFetch(...)`:

1. The DO starts the HTTP request to the container
2. **Other requests to the same sandbox CAN start executing**
3. Multiple `exec()` calls can be "in flight" simultaneously at the DO level
4. The DO does NOT serialize container requests

This is by design - we don't want one slow command to block all others. Serialization happens at a different layer (SessionManager in the container).

### blockConcurrencyWhile() - Full Serialization

For cases where you need complete serialization (like initialization), use `blockConcurrencyWhile()`:

```javascript
constructor(ctx, env) {
  ctx.blockConcurrencyWhile(async () => {
    // No other requests can execute until this completes
    await this.initialize();
  });
}
```

From the [documentation](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile):

> "blockConcurrencyWhile executes an async callback while blocking any other events from being delivered to the Durable Object until the callback completes."

Use sparingly - it limits throughput to one request at a time.

## Layer 3: Container HTTP Server (Bun)

### How It Works

Bun (like Node.js) uses a **single-threaded event loop**. JavaScript executes on one thread, but I/O operations are non-blocking. Multiple HTTP requests can be "in flight" simultaneously.

When two HTTP requests arrive:

1. Both enter the event loop
2. Both start processing (calling handlers, services)
3. When one hits an `await`, the other can continue
4. JavaScript never executes in parallel, but I/O operations do

This is the standard JavaScript runtime model - the same as Node.js, browsers, and Workers.

### Why It Matters

The container HTTP server can handle many concurrent requests. Without explicit synchronization:

- Two `exec()` requests could both reach the SessionManager simultaneously
- Two file operations could interleave
- Process management operations could race

### Our Solution: SessionManager Mutex

We deliberately serialize command execution within a session using a mutex:

```javascript
// In SessionManager
async executeInSession(sessionId, command) {
  const session = await this.getOrCreateSession(sessionId);

  // Mutex serializes execution WITHIN this session
  return session.mutex.runExclusive(async () => {
    return session.execute(command);
  });
}
```

**Why we do this**:

- Commands may depend on working directory state (`cd /foo && npm install`)
- Environment variables are session-scoped
- Without serialization, two commands could see inconsistent state

**What this means**:

- Commands in the SAME session run sequentially
- Commands in DIFFERENT sessions can run in parallel
- Multiple sandboxes (different DO instances) are completely independent

**Background processes**: When starting a background process via `startProcess()`, the mutex is released after the process emits its 'start' event (not after exit). This allows subsequent commands to run while the background process continues.

## Layer 4: Shell Execution

### True Parallelism

When `Bun.spawn()` creates a child process, it's a **real OS process** - separate memory space, scheduled by the kernel, can run on different CPU cores.

```javascript
// These run in TRUE parallelism
const proc1 = Bun.spawn(['python', 'script1.py']);
const proc2 = Bun.spawn(['python', 'script2.py']);
// Both execute simultaneously as separate OS processes
```

This is fundamentally different from JavaScript's event loop concurrency:

- Event loop: One thread, interleaved execution
- Spawned processes: Multiple threads/cores, true parallel execution

### What This Means

- A long-running process doesn't block other processes
- Background processes (`startProcess()`) run independently
- Resource contention (CPU, memory, disk) is managed by the OS
- Session serialization only affects when commands START, not their parallel execution

## Summary: Where Is Serialization?

| Layer           | Concurrency Model        | Serialization Point                |
| --------------- | ------------------------ | ---------------------------------- |
| Workers         | Event loop, interleaving | None (stateless pass-through)      |
| Durable Object  | Event loop, input gates  | Storage operations only            |
| Container HTTP  | Event loop, interleaving | SessionManager mutex (per session) |
| Shell Processes | True parallelism         | None (OS scheduled)                |

## Guidelines for Contributors

### In the Sandbox DO (packages/sandbox/)

**Safe:**

- Storage operations (protected by input gates)
- Stateless request handling

**Requires care:**

- In-memory state that persists across `await containerFetch()`
- Maps/caches that could be modified by concurrent requests
- Any mutable state accessed before and after non-storage async calls

**Pattern to avoid:**

```javascript
// RISKY: state may change during fetch
const token = this.tokenMap.get(port);
await this.containerFetch(...);  // Other requests can run!
this.tokenMap.set(port, newToken);  // May overwrite concurrent changes
```

**Safer pattern:**

```javascript
// Use storage for cross-request state
const token = await this.ctx.storage.get(`port:${port}:token`);
await this.containerFetch(...);
await this.ctx.storage.put(`port:${port}:token`, newToken);
```

**Note on caching:** The DO runtime already caches storage reads in memory, so maintaining your own in-memory cache (like a Map) is redundant and introduces consistency risks. Just use storage directly - input gates ensure correctness, and the runtime handles performance.

### In the Container (packages/sandbox-container/)

**Already handled:**

- SessionManager serializes command execution per session
- ProcessManager handles concurrent process operations

**Requires care:**

- Shared in-memory state in services
- State in handlers that persists across requests
- Any singleton that multiple requests might access concurrently

**Key principle**: Assume any async operation can be interleaved with other requests. Use mutexes where ordering matters.

### Testing Concurrent Behavior

When testing concurrency:

- Use different sessions for parallel operations
- Test what happens when multiple requests hit the same session
- Verify that concurrent requests don't corrupt shared state

## References

- [Cloudflare Workers: How Workers Works](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- [Durable Objects: Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- [Durable Objects: Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Objects: In-memory State](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
- [Durable Objects: blockConcurrencyWhile](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)
