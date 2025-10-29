# Session Execution Architecture

This document explains how the container session executes commands reliably while preserving shell state and separating stdout/stderr.

## Goals

- Preserve session state across commands (cwd, env vars, shell functions)
- Cleanly separate stdout and stderr for each command
- Be robust to commands that produce no output (e.g., `cd`, `mkdir`, variable assignment)
- Provide deterministic completion signaling (exit code file) without hanging

## Two Execution Modes

### Foreground (`exec`)

- Runs in the main bash shell so state persists across commands.
- Uses bash process substitution to prefix stdout/stderr inline and append to the per-command log file.
- After the command returns, we `wait` to ensure process-substitution consumers finish writing to the log before we write the exit code file.
- Why process substitution (not FIFOs):
  - Foreground previously used FIFOs + background labelers, which can race on silent commands because FIFO open/close ordering depends on cross-process scheduling.
  - Process substitution keeps execution local to the main shell and avoids FIFO semantics entirely.

Pseudo:

```
# Foreground
{ command; } \
  > >(while read; printf "\x01\x01\x01%s\n" "$REPLY" >> "$log") \
  2> >(while read; printf "\x02\x02\x02%s\n" "$REPLY" >> "$log")
EXIT_CODE=$?
# Ensure consumers have drained
wait 2>/dev/null
# Atomically publish exit code
echo "$EXIT_CODE" > "$exit.tmp" && mv "$exit.tmp" "$exit"
```

### Background (`execStream` / `startProcess`)

- Uses named FIFOs and background labelers:
  - Create two FIFOs (stdout/stderr)
  - Start two background readers (labelers) that read each FIFO and prepend a binary prefix per line, appending to the log
  - Run the command in a subshell redirected to the FIFOs
  - Write the exit code file and clean up FIFOs after readers finish
- This pattern works well for concurrent streaming and avoids blocking the main shell.

Pseudo:

```
mkfifo "$sp" "$ep"
( while read; printf "\x01\x01\x01%s\n" "$REPLY"; done < "$sp" ) >> "$log" & r1=$!
( while read; printf "\x02\x02\x02%s\n" "$REPLY"; done < "$ep" ) >> "$log" & r2=$!
{
  command
  CMD_EXIT=$?
  echo "$CMD_EXIT" > "$exit.tmp" && mv "$exit.tmp" "$exit"
} > "$sp" 2> "$ep" & CMD_PID=$!
# Monitor waits for readers to finish and then removes FIFOs
( wait "$r1" "$r2" 2>/dev/null; rm -f "$sp" "$ep" ) &
```

## Binary Prefix Contract

- We use short binary prefixes per line to distinguish streams:
  - Stdout lines: `\x01\x01\x01`
  - Stderr lines: `\x02\x02\x02`
- The log parser splits the log by these prefixes to reconstruct stdout/stderr.
- Unprefixed lines (should not occur) are ignored.

## Completion Signaling

- For each command we write an exit code file: `<id>.exit` with the numeric exit code.
- The container waits for this file using a hybrid `fs.watch` + polling approach to be robust on tmpfs/overlayfs where rename events may be missed.
- Exit file writes are performed via `tmp` + `mv` for atomicity.

## Error Handling and Limits

- Invalid `cwd` (foreground): we write a prefixed stderr line (binary prefix) indicating the failure and return exit code `1`.
- Output size limit: large logs are rejected during parsing to protect memory (`MAX_OUTPUT_SIZE_BYTES`).
- Timeouts: foreground commands can be configured to time out; an error is raised if the exit file does not appear in time.

## Why Two Patterns?

- Foreground requires state persistence in the main shell. Process substitution provides reliable separation without cross-process FIFO races.
- Background requires concurrent streaming and process tracking (PID etc.), which is well-served by FIFOs + labelers without blocking the main shell.

## Testing Notes

- Foreground tests cover silent commands (`cd`, variable assignment), error scenarios, multiline output, and size limits.
- Background/streaming tests cover concurrent output, stderr separation, and completion events.
- The previous hang class was caused by FIFO open/close races in foreground on silent commands; process substitution removes this class entirely.

## FAQ

- Why not unify on a single mechanism?
  - Foreground needs state persistence and deterministic completion without cross-process scheduling hazards; process substitution is ideal.
  - Background needs streaming and concurrency; FIFOs provide clean decoupling.
- Why not tee? Tee doesn’t split stdout/stderr into separate channels with stable ordering without extra plumbing; our prefixes are simple and explicit.
- Is process substitution portable?
  - It is supported by bash (we spawn bash with `--norc`). The container environment supports it; if portability constraints change, we can revisit.
