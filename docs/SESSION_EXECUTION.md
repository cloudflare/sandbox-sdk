# Session Execution Architecture

This document explains the **architecture and design decisions** for command execution in the container session. For implementation details (bash idioms, data flow diagrams, annotated code patterns), see the source file:

📁 **Implementation**: [`packages/sandbox-container/src/session.ts`](../packages/sandbox-container/src/session.ts)

## Goals

1. **Preserve session state** across commands (cwd, env vars, shell functions)
2. **Separate stdout and stderr** reliably for each command
3. **Handle silent commands** (e.g., `cd`, `mkdir`, variable assignment) without hanging
4. **Signal completion deterministically** via exit code files
5. **Support process termination** including all descendant processes

## Two Execution Modes

We use two distinct patterns because they have fundamentally different requirements:

| Mode           | API                              | State Persists? | Streaming? | Killable?           |
| -------------- | -------------------------------- | --------------- | ---------- | ------------------- |
| **Foreground** | `exec()`                         | ✅ Yes          | ❌ No      | ❌ No (use timeout) |
| **Background** | `execStream()`, `startProcess()` | ❌ No           | ✅ Yes     | ✅ Yes              |

### Foreground (`exec`)

**Design goal**: Run commands in the main shell so state changes (cd, export, functions) persist.

**Approach**: Temp files + synchronous prefixing

```
Command ──▶ stdout.tmp, stderr.tmp ──▶ Prefix lines ──▶ log file ──▶ exit code
            (file redirects)           (synchronous)     (merged)     (atomic write)
```

**Why temp files instead of FIFOs?**

- File redirects are synchronous - bash waits for all writes before continuing
- FIFOs/process substitution are asynchronous - writes may be buffered when we try to read
- This eliminates race conditions with large outputs (e.g., base64-encoded files)

**Why this works for state persistence**:

- Uses `{ cmd }` (group command) not `( cmd )` (subshell)
- Group commands run in the current shell, so `cd`, `export`, etc. affect subsequent commands

### Background (`execStream` / `startProcess`)

**Design goal**: Stream output in real-time while the command runs, support cancellation.

**Approach**: FIFOs + background labelers + monitor

```
Command ──▶ stdout.pipe (FIFO) ──▶ Labeler r1 ──┐
        ──▶ stderr.pipe (FIFO) ──▶ Labeler r2 ──┼──▶ log file
                                                │
Monitor: wait for labelers, cleanup FIFOs ──────┘
```

**Why FIFOs for background?**

- Enable concurrent streaming (TypeScript reads log while command writes)
- Command runs in subshell, doesn't block main shell
- PID is captured for process management

**Why not use FIFOs for foreground?**

- FIFOs require background labelers, which introduce async timing
- Silent commands (no output) can cause FIFO blocking issues
- State wouldn't persist (subshell isolation)

## Binary Prefix Contract

Each line in the log file is prefixed to identify its source:

| Stream | Prefix         | Bytes |
| ------ | -------------- | ----- |
| stdout | `\x01\x01\x01` | 3     |
| stderr | `\x02\x02\x02` | 3     |

The TypeScript `parseLogFile()` method strips these prefixes to reconstruct separate streams.

**Why 3 bytes?** Minimizes collision probability with actual output while keeping overhead small.

## Completion Signaling

**Problem**: How does TypeScript know when a bash command has finished?

**Solution**: Exit code file with hybrid detection

1. Command writes exit code to `<id>.exit.tmp`
2. Atomic rename: `mv <id>.exit.tmp <id>.exit`
3. TypeScript detects via `fs.watch` + polling fallback

**Why hybrid detection?**

- `fs.watch` is fast but unreliable on tmpfs/overlayfs (misses rename events)
- Polling is reliable but slow
- Hybrid gives fast detection with reliable fallback

## Process Termination

**Problem**: Killing a process doesn't kill its children. Commands like `bash -c "sleep 100 &"` spawn children that escape normal termination.

**Solution**: /proc tree walking (depth-first)

```
bash(100) ──▶ python(101) ──▶ worker(102)

Kill order: worker(102), python(101), bash(100)
```

**Why depth-first?**

- If parent dies first, children get re-parented to init (PID 1)
- We lose track of orphaned children
- Killing children first ensures complete cleanup

**Why not process groups?**

- `bash -c "cmd &"` creates new process groups
- `kill(-pgid)` misses children in different groups
- /proc traversal finds ALL descendants regardless of groups

**Implementation**: See `killCommand()` in session.ts

## TypeScript Patterns

The session uses several TypeScript patterns that may be unfamiliar:

### Shell Death Detection (`shellExitedPromise`)

A Promise that **never resolves, only rejects** when the shell dies:

```typescript
// Used in Promise.race to detect shell termination during command execution
await Promise.race([
  this.waitForExitCode(exitCodeFile), // Normal completion
  this.shellExitedPromise // Shell died (rejects)
]);
```

This allows immediate detection if the shell terminates unexpectedly (e.g., user runs `exit`).

### Hybrid File Detection (`waitForExitCode`)

Combines multiple detection mechanisms for reliability:

1. `fs.watch` on directory (fast, but unreliable on some filesystems)
2. Polling fallback every 50ms (reliable, but slower)
3. Timeout if configured
4. Initial existence check (file may already exist)

### PID Synchronization (`waitForPidViaPipe`)

Reliable PID capture using FIFOs:

1. **Primary**: Read PID from FIFO (blocking, guaranteed synchronization)
2. **Fallback**: If FIFO times out, poll PID file

**Why FIFO for PID?** File polling has race conditions - the PID file might not exist yet or might be partially written. FIFO read blocks until the shell writes, guaranteeing we get the complete PID.

## Error Handling

| Scenario        | Behavior                                  |
| --------------- | ----------------------------------------- |
| Invalid cwd     | Write prefixed stderr, return exit code 1 |
| Command timeout | Reject with timeout error                 |
| Shell death     | Reject with "shell terminated" error      |
| Kill timeout    | Escalate SIGTERM → SIGKILL                |

## FAQ

**Why two execution patterns instead of one?**

They solve different problems:

- Foreground needs state persistence and synchronous completion
- Background needs streaming and process control

Unifying them would compromise one set of requirements.

**Why not use `tee` for stdout/stderr separation?**

`tee` doesn't split streams with stable ordering. Our binary prefixes are simpler and more explicit.

**Is this bash-specific?**

Yes. We spawn `bash --norc` and rely on bash features (group commands, FIFOs work reliably). If portability constraints change, we'd need to revisit.

**Why temp files over process substitution for foreground?**

Process substitution (`>(cmd)`) runs asynchronously. Bash returns when the substitution _starts_, not when it _finishes writing_. With large outputs, reads can happen before writes complete. Temp files with direct redirects ensure bash waits for all writes.

## Related Files

- [`packages/sandbox-container/src/session.ts`](../packages/sandbox-container/src/session.ts) - Implementation with detailed comments
- [`packages/sandbox-container/tests/session.test.ts`](../packages/sandbox-container/tests/session.test.ts) - Unit tests
- [`tests/e2e/process-lifecycle-workflow.test.ts`](../tests/e2e/process-lifecycle-workflow.test.ts) - E2E process tests
