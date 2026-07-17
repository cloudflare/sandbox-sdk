---
name: architecture
description: Use when changing SDK layering, request flow, process execution, terminals, bridge routes, container control APIs, or Durable Object lifecycle behavior.
---

# Architecture

The Sandbox is a long-running computer identified by a Durable Object. The current container runtime owns runtime-local processes, terminals, logs, and cursors.

## Layers

| Layer             | Package                   | Owns                                                                                        |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| Public SDK / DO   | `@cloudflare/sandbox`     | public API, container lifecycle, preview auth, bridge routes, thin process/terminal handles |
| Shared contracts  | `@repo/shared`            | internal types, RPC contracts, errors                                                       |
| Container runtime | `@repo/sandbox-container` | process supervisor, PTYs, retained logs, file/port/git services                             |

Dependency direction is SDK/container -> shared. Container code must not import the public SDK.

## Execution model

- `sandbox.exec(argv, options)` is the only public supervised process launch primitive.
- Commands are argv arrays. Use `['/bin/bash', '-lc', script]` for shell programs.
- `exec()` is the only process operation that may wake a runtime and resolves after launch confirmation, not process completion.
- Handles expose runtime-local `id`/`pid`, status, replayable output/logs, waits, and numeric `kill()`.
- `cwd` is selected per launch; processes and terminals inherit the complete container environment and apply `env` as an overlay.
- `exec(argv, { timeout })` is a remote process lifetime deadline that may TERM-to-KILL internally and reports `timedOut: true`; observer timeouts and `AbortSignal`s are caller-local and never stop the process.
- `sandbox.getProcess(id)` and `listProcesses()` are non-waking discovery operations.
- Stale process handles fail instead of attaching to a replacement runtime.
- `createTerminal()` / `getTerminal(id)` own separate PTY input, resize, interrupt, terminate, and reconnect semantics.
- Process/terminal IDs and logs are not durable across container sleep, restart, or replacement.

## Invariants

1. One supervisor-backed argv process primitive.
2. One PTY primitive and one cursor-retention algorithm.
3. No persistent execution shell hidden behind `exec()`.
4. No command shape or mode flag selects lifecycle.
5. Durable Object storage is not authoritative for process or terminal liveness.
6. Active-resource leases are owned by the runtime resource layer and are released on exit.
7. Wrappers must enforce an invariant; do not add forwarding-only layers.
8. New/extracted source should stay under 500 lines and must stay under 800.

See `docs/ARCHITECTURE.md` and `docs/PROCESS_EXECUTION.md` for contributor-facing details.
