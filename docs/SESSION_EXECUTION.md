# Session Execution Architecture

This document describes the current command execution model in the sandbox
runtime. The model intentionally separates completion-only command execution,
process lifecycle management, and terminal/PTY interaction.

## Goals

1. Make top-level execution stateless unless the caller explicitly creates a
   session.
2. Preserve shell state for explicit command sessions (`cd`, `export`, aliases,
   functions, sourced scripts).
3. Keep `exec()` completion-only: it returns final stdout, stderr, and exit code.
4. Put streaming, cancellation, timeout recovery, and process-tree cleanup on
   `startProcess()`.
5. Keep terminal resources separate from command sessions. Terminals expose PTY
   bytes, not structured stdout/stderr.

## Public Execution Surfaces

| API                      | State persists?                  | Streaming? | Killable?                     | Runtime primitive               |
| ------------------------ | -------------------------------- | ---------- | ----------------------------- | ------------------------------- |
| `sandbox.exec()`         | No                               | No         | No                            | `StatelessCommandRunner`        |
| `sandbox.startProcess()` | No                               | Yes        | Yes                           | `StatelessProcessRunner`        |
| `session.exec()`         | Yes                              | No         | No                            | `CommandSession.exec()`         |
| `session.startProcess()` | Inherits session state at launch | Yes        | Yes                           | `CommandSession.startProcess()` |
| `sandbox.terminal()`     | Independent PTY state            | PTY bytes  | Destroyable terminal resource | `TerminalManager` / `Pty`       |

There is no public streaming `exec()` API. Streaming belongs to process
resources, not completion-only command calls.

## Top-Level Stateless Execution

Top-level calls do not create or reuse hidden sessions.

```text
sandbox.exec(command)
  -> ProcessService.executeCommand(..., DISABLE_SESSION_TOKEN)
  -> ExecutionService.executeSessionless(...)
  -> StatelessCommandRunner.exec(...)
```

`StatelessCommandRunner` runs a one-shot shell command. Each call gets only the
explicit `cwd`, `env`, and timeout options supplied for that call. State changes
such as `cd`, `export`, aliases, and shell functions do not persist.

For streaming/lifecycle:

```text
sandbox.startProcess(command)
  -> ProcessService.startProcess(..., DISABLE_SESSION_TOKEN)
  -> ExecutionService.executeStreamSessionless(...)
  -> StatelessProcessRunner.start(...)
```

`StatelessProcessRunner` owns stdout/stderr streaming, wait, kill, timeouts, and
process-tree termination for sessionless processes.

## Explicit Command Sessions

Explicit sessions are persistent, structured command sessions. `SessionManager`
owns the per-session queue and lifecycle; the actual shell runtime lives in
`@repo/sandbox-execution`.

```text
session.exec(command)
  -> SessionManager.executeInSession(...)
  -> RuntimeBackedSession.exec(...)
  -> CommandSession.exec(...)
```

`CommandSession.exec()` runs in the persistent bash shell so state changes write
back to the session. It is completion-only and returns:

```ts
{
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

Because this command runs in the main persistent shell, it is not a process
lifecycle API. It does not expose streaming, `kill()`, or recoverable
cancellation. If callers need lifecycle control, they should use
`session.startProcess()`.

## Session Processes

`session.startProcess()` starts a process from a snapshot of the current session
state.

```text
session.startProcess(command)
  -> SessionManager.executeStreamInSession(...)
  -> RuntimeBackedSession.execRuntimeProcessStream(...)
  -> CommandSession.startProcess(...)
```

The process can stream stdout/stderr and can be killed or timed out. Changes made
inside that process do not write back to the parent command session. This keeps
process lifecycle deterministic while preserving the useful behavior that
session-defined cwd/env/aliases/functions are available when the process starts.

### Output Events

Process streaming emits structured events through the container service layer:

- `start` with the process PID.
- `stdout` and `stderr` chunks while the process runs.
- `complete` with exit code and final result, or `error` if startup/lifecycle
  fails.

The container service layer keeps existing `ProcessRecord`, command handle, and
SSE framing semantics. The execution package owns the shell/process mechanics.

## Terminal Resources

Terminals are independent PTY resources, not command-session helpers.

```text
sandbox.terminal({ id, cwd, shell })
  -> terminals.createTerminal({ id, cwd, shell, cols, rows }) over RPC
  -> /ws/terminal?terminalId=... for byte transport
```

Terminal output is a PTY byte stream suitable for xterm-like clients. It does
not promise structured stdout/stderr separation. Terminal lifecycle operations
such as `destroy()` use semantic RPC methods; `/ws/terminal` is the byte
transport for attaching to an existing terminal.

## Completion-Only Persistent Exec Mechanics

Both the legacy container `Session` implementation and the runtime
`CommandSession.exec()` use the same core idea for persistent, completion-only
execution:

1. Run the command in the persistent bash shell so state can persist.
2. Redirect stdout and stderr to command-specific temp files.
3. Wait for shell redirections to finish.
4. Publish a bounded completion frame or exit-code marker.
5. Read stdout/stderr files and return final strings.

The important design point is that temp-file redirects are synchronous from the
shell's point of view. Bash waits for the command's redirected output to finish
before the integration reports command completion.

## Binary Prefix Contract in `session.ts`

`packages/sandbox-container/src/session.ts` still uses a local command log with
binary prefixes for its completion-only `exec()` implementation:

| Stream | Prefix         | Bytes |
| ------ | -------------- | ----- |
| stdout | `\x01\x01\x01` | 3     |
| stderr | `\x02\x02\x02` | 3     |

The parser strips these prefixes to reconstruct stdout and stderr. This legacy
class no longer exposes `execStream()`, `killCommand()`, or running-command
tracking; service-level session execution is runtime-backed through
`CommandSession`.

## Completion Signaling

### `packages/sandbox-container/src/session.ts`

The legacy completion-only `Session` writes `<id>.exit.tmp` and atomically
renames it to `<id>.exit`. TypeScript detects completion with a hybrid
`fs.watch` plus polling fallback.

### `@repo/sandbox-execution` `CommandSession`

The runtime command session emits framed control messages on stdout and uses
command-specific result files for bounded stdout/stderr reads. Process streaming
uses FIFO readers internally, but that machinery is private to the execution
package and is not exposed as `Session.execStream()`.

## Error Handling

| Scenario                   | Behavior                                                                          |
| -------------------------- | --------------------------------------------------------------------------------- |
| Invalid per-command `cwd`  | Command does not run; stderr explains the failed directory change                 |
| `exec()` timeout           | The command session is failed when safe recovery is not guaranteed                |
| Shell exit during `exec()` | The session is marked terminated and later calls recover through `SessionManager` |
| `startProcess()` timeout   | Runtime terminates the process tree and preserves partial output                  |
| `startProcess().kill()`    | Runtime signals the process tree                                                  |
| Terminal destroy           | `TerminalManager` destroys the PTY resource                                       |

## Concurrency

`SessionManager` serializes operations per explicit command session. Completion
commands run one at a time because they mutate shell state. Process streaming
holds the session lock only long enough to start the process and capture its
handle; the process then runs independently so later session commands can run.

Different sessions and stateless top-level processes can run concurrently.

## Related Files

- [`packages/sandbox-execution/src/command-session.ts`](../packages/sandbox-execution/src/command-session.ts) - Runtime-backed persistent command sessions and session processes.
- [`packages/sandbox-execution/src/stateless-command-runner.ts`](../packages/sandbox-execution/src/stateless-command-runner.ts) - Stateless completion-only commands.
- [`packages/sandbox-execution/src/stateless-process-runner.ts`](../packages/sandbox-execution/src/stateless-process-runner.ts) - Stateless process lifecycle and streaming.
- [`packages/sandbox-container/src/services/session-manager.ts`](../packages/sandbox-container/src/services/session-manager.ts) - Container session lifecycle, locking, and service event mapping.
- [`packages/sandbox-container/src/session.ts`](../packages/sandbox-container/src/session.ts) - Legacy completion-only persistent shell implementation.
- [`packages/sandbox-container/src/services/terminal-manager.ts`](../packages/sandbox-container/src/services/terminal-manager.ts) - Terminal resource lifecycle.
