---
name: session-execution
description: Use when working on or reviewing session execution, command handling, shell state, FIFO-based streaming, or stdout/stderr separation. Relevant for session.ts, command handlers, exec/execStream, or anything involving shell process management. (project)
---

# Session Execution

Read `docs/SESSION_EXECUTION.md` before working in this area. It explains the architecture for reliable command execution with stdout/stderr separation.

## Key Concepts

**Two execution modes:**

- **Foreground (exec)**: Runs in main shell, state persists. Uses temp files for output capture.
- **Background (execStream/startProcess)**: Runs in subshell via FIFOs. Labelers prefix output in background.

**Binary prefix contract:**

- Stdout: `\x01\x01\x01` prefix per line
- Stderr: `\x02\x02\x02` prefix per line
- Log parser reconstructs streams from these prefixes

**Completion signaling:**

- Exit code written to `<id>.exit` file via atomic `tmp` + `mv`
- Hybrid fs.watch + polling detects completion (robust on tmpfs/overlayfs)
- Background mode uses `labelers.done` marker to ensure output is fully captured

## When Developing

- Understand why foreground uses temp files (bash waits for redirects to complete)
- Understand why background uses FIFOs (concurrent streaming without blocking shell)
- Test silent commands (cd, variable assignment) - these historically caused hangs
- Test large output - buffering issues can cause incomplete logs

## When Reviewing

**Correctness checks:**

- Verify exit code handling is atomic (write to .tmp then mv)
- Check FIFO cleanup in error paths
- Ensure labelers.done is awaited before reading final output (background mode)

**Race condition analysis:**

Session execution has a mutex that serializes command execution per session. Before flagging race conditions:

1. Check if operations happen within the same session (mutex protects)
2. Check if operations are per-session vs cross-session (cross-session races are real)
3. Refer to `docs/CONCURRENCY.md` for the full concurrency model

**Common false positives:**

- "Concurrent reads/writes to session state" - mutex serializes these
- "FIFO operations might race" - labelers are per-command, not shared

**Actual concerns to watch for:**

- Cross-session operations without proper isolation
- Cleanup operations that might affect still-running commands
- File operations outside the mutex-protected section

## Key Files

- `packages/sandbox-container/src/session.ts` - Session class with exec/execStream
- `packages/sandbox-container/src/managers/SessionManager.ts` - Mutex and lifecycle
- `packages/sandbox/src/clients/CommandClient.ts` - SDK interface to session commands
