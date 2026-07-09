# Sandbox SDK Architecture

The Sandbox SDK runs isolated computers on Cloudflare Containers. A Sandbox Durable Object gives each computer a stable identity and lifecycle, while the current container runtime owns runtime-local processes, terminals, and logs.

## Layers

1. **`@cloudflare/sandbox` (`packages/sandbox`)**: public SDK, Durable Object, preview proxy, process and terminal handles, bridge routes.
2. **`@repo/shared` (`packages/shared`)**: internal type and error contracts shared by SDK and container. It is not published independently.
3. **`@repo/sandbox-container` (`packages/sandbox-container`)**: Bun control plane inside the container, process supervisor, PTY server, file/port/git services.

The SDK depends on shared types and the container implements them. Container code does not import the public SDK.

## Control channels

- `/rpc` WebSocket: typed capnweb control plane for files, ports, processes, terminals, backups, mounts, tunnels, and extensions.
- Preview/proxy requests: user service traffic authorized by the Sandbox DO.
- Terminal WebSocket: PTY I/O for interactive terminals.

## Process execution

`sandbox.exec(argv, options)` is the single public supervised process primitive and the only process operation that may start a runtime. It accepts argv only and resolves once the runtime confirms launch, not when the process exits. Shell behavior is explicit: use `['/bin/bash', '-lc', script]` when a shell is required. The returned handle exposes immutable `id` and numeric `pid` fields plus `status()`, replayable `output()` and `logs()`, waits, and numeric `kill()`.

`cwd` is selected per launch. Processes and terminals inherit the complete container environment and apply `env` as an overlay. These launch options do not mutate the Sandbox computer or create a persistent shell. Separate Worker requests recover a live process with `sandbox.getProcess(id)` and resume logs from saved cursors. `getProcess()` and `listProcesses()` are non-waking and report no processes when there is no current runtime. Handles, IDs, PIDs, statuses, cursors, and retained logs are runtime-local; after sleep, restart, or replacement, old handles fail as stale rather than binding to the replacement. `exec(argv, { timeout })` sets a remote process lifetime deadline: the supervisor may terminate and then kill the process internally, and the exit outcome is reported with `timedOut: true`. By contrast, `AbortSignal`s and timeout options on `logs()`, `output()`, `waitForExit()`, `waitForLog()`, and `waitForPort()` cancel only that caller's local observation and never stop the process.

See [PROCESS_EXECUTION.md](./PROCESS_EXECUTION.md).

## Terminals

`createTerminal()` is the single PTY primitive for interactive shells. A terminal has its own ID, cursor-retained output, input, resize, interrupt, terminate, and reconnect path via `getTerminal(id)`. These terminal controls are intentionally separate: use terminals for interactive PTY state and `exec()` for supervised argv processes and numeric signals.

## Active resources

The current runtime owns active process and terminal leases. Active resources pin the live Sandbox independent of the Worker request that launched them. Durable Object storage records durable sandbox configuration such as preview ports and mounts, not process or terminal truth.

## Concurrency

Workers, Durable Objects, and Bun are single-threaded event loops that interleave at awaits. Spawned processes and PTYs are OS resources and run independently. The SDK does not serialize unrelated process launches; callers coordinate their own workload-level ordering.

## Testing

Unit tests cover SDK handle behavior, bridge schemas, and container services. E2E tests prove real Docker/Worker behavior for argv execution, process recovery, cursor replay, active pinning, terminal reconnects, and coding-agent harness mechanics.
