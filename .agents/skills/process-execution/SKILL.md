---
name: process-execution
description: Use when documenting, testing, or implementing Sandbox command execution, process recovery, log cursors, terminals, or coding-agent harnesses.
---

# Process Execution

The Sandbox is the long-running computer. `sandbox.exec()` launches one supervised argv process; it is not a hidden shell and it does not preserve shell state.

## Current APIs

```ts
const process = await sandbox.exec(['python3', '-c', 'print(2 + 2)']);
const output = await process.output({ encoding: 'utf8' });

console.log(process.id, process.pid, output.stdout, output.exitCode);
```

- Use argv arrays only. Shell syntax requires explicit shell argv such as `['/bin/bash', '-lc', script]`.
- `await sandbox.exec(argv)` waits for launch; `output()`, `waitForExit()`, and `exitCode` wait for completion.
- Use `status()` for the current state and `kill(signal)` for a numeric signal (default 15).
- `output()` buffers replayable output and may return `truncated: true`; `logs({ since, replay, follow })` provides incremental replay and cursor resume.
- Keep `process.id` for asynchronous work and recover with `sandbox.getProcess(id)` while the owning runtime is alive.
- `getProcess()` and `listProcesses()` do not wake a runtime; without one they return `null` and `[]`.
- `exec(argv, { timeout })` is a remote process lifetime deadline: the supervisor may TERM-to-KILL the process internally and the exit outcome reports `timedOut: true`.
- Timeouts and `AbortSignal`s on `logs()`, `output()`, `waitForExit()`, `waitForLog()`, and `waitForPort()` cancel only the caller's local observation. They never stop the process.
- Select `cwd` per launch. Processes and terminals inherit the complete container environment and apply `env` as an overlay without mutating future launches.
- Use `createTerminal()` and `getTerminal(id)` for persistent interactive PTY shells and their distinct input, resize, interrupt, terminate, and reconnect controls.

## Runtime lifetime

Process handles, IDs, PIDs, statuses, retained logs, and cursors are runtime-local. They survive separate Worker requests while the container stays alive, but they are not durable across sleep, restart, or replacement. Old handles fail with `STALE_PROCESS_HANDLE` and never attach to a replacement runtime.

## Harness patterns

- Pi/Codex/OpenCode setup scripts: `sandbox.exec(['/bin/bash', '-lc', script], { cwd, env })`.
- Long-running services: store `process.id`, wait for readiness with `waitForPort()` or `waitForLog()`.
- Human interactive shells: create a terminal instead of using process logs as a terminal.

## Common mistakes

| Mistake                               | Use instead                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Passing a command string              | Pass argv, or explicit Bash argv for shell syntax.                                 |
| Expecting `cd` or `export` to persist | Put related shell work in one Bash launch, or use a terminal.                      |
| Treating IDs as durable records       | Store enough job metadata to relaunch after runtime loss.                          |
| Creating a wrapper that only forwards | Add an invariant such as argv validation, cursor retention, or readiness handling. |
