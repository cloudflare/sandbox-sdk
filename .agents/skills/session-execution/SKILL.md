---
name: session-execution
description: Use when working on or reviewing session execution, command handling, shell state, process streaming, or stdout/stderr separation. Relevant for session-manager.ts, session.ts, @repo/sandbox-execution, exec/startProcess, or shell process management. (project)
---

# Session Execution

Read `docs/SESSION_EXECUTION.md` before working in this area. It explains the
current split between stateless commands, explicit command sessions, process
lifecycle, and terminal resources.

## Key Concepts

**Execution surfaces:**

- `sandbox.exec()` is stateless and completion-only. It uses
  `StatelessCommandRunner` and never creates persistent shell state.
- `sandbox.startProcess()` is stateless process lifecycle. It uses
  `StatelessProcessRunner` for streaming, wait, kill, timeout, and process-tree
  cleanup.
- `session.exec()` is persistent-session completion-only. It uses
  `CommandSession.exec()` and writes shell state changes back to the command
  session.
- `session.startProcess()` starts a lifecycle-managed process from inherited
  session state. It streams output and can be killed/timed out, but process
  mutations do not write back to the parent session.
- `sandbox.terminal()` is an independent PTY resource. Terminal transcript/bytes
  are separate from structured command stdout/stderr.

**No public streaming exec:**

Streaming belongs to `startProcess()`. Do not add `execStream()` or
`exec({ stream: true })` back to the public or container service APIs.

**Completion-only exec capture:**

- Persistent `exec()` runs in the main shell so `cd`, `export`, aliases,
  functions, and sourced scripts can persist.
- stdout and stderr are redirected to command-specific files and read after the
  shell reports completion.
- The legacy `packages/sandbox-container/src/session.ts` class is now
  completion-only; it must not expose `execStream()`, `killCommand()`, or
  running-command tracking.

**Process lifecycle:**

- Process streaming and kill behavior live in `@repo/sandbox-execution` and are
  adapted by `SessionManager` / `ProcessService`.
- Keep service-level `ExecEvent`, `ProcessRecord`, command handle, and SSE
  shapes stable when migrating internals.
- Process cleanup covers ordinary descendants; detached or reparented processes
  remain a known Unix boundary.

## When Developing

- Preserve the distinction between completion commands and lifecycle processes.
- Test shell state persistence for `session.exec()` (`cd`, `export`, aliases,
  functions, sourced scripts).
- Test that process streaming does not block later commands after the process
  has started.
- Test timeout/kill paths preserve partial output and keep the parent session
  usable when the API promises recovery.
- Keep terminals separate from command sessions; do not route terminal behavior
  through session state.

## When Reviewing

**Correctness checks:**

- Verify top-level execution uses the sessionless token/runtime and does not
  create a default session.
- Verify `session.exec()` remains completion-only and does not expose streaming
  or cancellation promises it cannot safely keep.
- Verify `session.startProcess()` maps lifecycle events through the runtime
  process path, not legacy `Session` methods.
- Verify terminal creation/destroy use semantic lifecycle APIs and `/ws/terminal`
  remains byte transport only.

**Race condition analysis:**

Session execution has a mutex that serializes operations per explicit command
session. Before flagging race conditions:

1. Check whether operations happen in the same session; the mutex protects
   session state mutations.
2. Check whether a process has already emitted `start`; after that the lock is
   intentionally released while the process continues independently.
3. Check whether the operation is per-session or cross-session; cross-session
   races are real.
4. Refer to `docs/CONCURRENCY.md` for the full concurrency model.

**Actual concerns to watch for:**

- Reintroducing hidden/default session state for top-level execution.
- Mixing terminal PTY semantics with structured stdout/stderr command results.
- Holding the session lock for the full lifetime of a long-running process.
- Cleanup paths that leave runtime process handles active after session failure
  or close.
- New `any` types or one-off protocol shapes instead of shared types.

## Key Files

- `packages/sandbox-execution/src/command-session.ts` - Runtime persistent
  command sessions and session processes.
- `packages/sandbox-execution/src/stateless-command-runner.ts` - Stateless
  completion-only commands.
- `packages/sandbox-execution/src/stateless-process-runner.ts` - Stateless
  process lifecycle.
- `packages/sandbox-container/src/services/session-manager.ts` - Session
  lifecycle, locking, and runtime adapters.
- `packages/sandbox-container/src/session.ts` - Legacy completion-only shell
  implementation; not a service streaming/process-control path.
- `packages/sandbox-container/src/services/terminal-manager.ts` - Terminal
  resource lifecycle.
