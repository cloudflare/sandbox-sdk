---
name: session-execution
description: Use when working on or reviewing session execution, command handling, shell state, FIFO-based streaming, or stdout/stderr separation. Relevant for session.ts, command handlers, exec/execStream, or anything involving shell process management.
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

- Verify exit code handling is atomic
- Check FIFO cleanup in error paths
- Ensure labelers.done is awaited before reading final output (background mode)
- Look for race conditions in completion detection
