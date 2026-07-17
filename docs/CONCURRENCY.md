# Concurrency Model

Sandbox requests cross three JavaScript event loops and then launch OS resources. JavaScript execution is single-threaded at each layer, but `await` points allow requests to interleave.

## Layers

| Layer                  | Concurrency model                                                            | Sandbox rule                                                                |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Worker                 | V8 event loop; requests may hit different isolates                           | Keep request state local; recover runtime resources by ID.                  |
| Sandbox Durable Object | One active instance per Sandbox ID; storage gates protect storage operations | Store durable configuration only, not process or terminal truth.            |
| Container Bun server   | Event loop with concurrent async handlers                                    | Supervises processes, terminals, logs, and cursors for the current runtime. |
| OS processes/PTYs      | Kernel-scheduled resources                                                   | Independent launches can run in parallel.                                   |

## Process concurrency

`sandbox.exec(argv)` returns after launch confirmation. The process keeps running even if the Worker request returns. Multiple launches may run concurrently unless the caller's own program serializes them. `cwd` and `env` are copied into a single launch and do not become shared mutable state.

Use explicit shell argv when ordering is part of one shell program:

```ts
await sandbox.exec(['/bin/bash', '-lc', 'cd app && npm install && npm test']);
```

Use separate launches when tasks are independent. Use `getProcess(id)` and log cursors to resume observation from later requests.

## Terminal concurrency

A terminal is an interactive PTY resource. It owns terminal state and retained output for the current runtime. Reconnect by terminal ID and cursor; do not model a terminal as a series of process launches.

## Active resources

The active-resource lease is owned by the process/terminal runtime layer. Leases pin the live Sandbox while resources are active and are released when processes exit or are killed.

Terminal leases are released when terminals exit or terminate.

There is no heartbeat that makes Durable Object storage authoritative for process liveness.
