# Session Execution Deep Dive

## 1. The Deceptively Simple API

From the user's perspective, the Sandbox SDK API is minimal:

```typescript
// Execute a command, get result
const result = await sandbox.exec('pip install pandas && python train.py');
console.log(result.stdout, result.exitCode);

// Start a background process (streamable, killable)
const server = await sandbox.startProcess('npm run dev');
await server.waitForPort(3000);
await server.kill();

// Isolated sessions with persistent state
const session = await sandbox.createSession({ cwd: '/app' });
await session.exec('export API_KEY=secret');
await session.exec('node app.js'); // Has access to API_KEY
```

**Looks simple. Five hard problems are hiding underneath.**

---

## 2. The Five Hard Problems

### Problem 1: State Persistence

When a user runs multiple commands, they expect state to carry over:

```typescript
await session.exec('cd /app'); // Change directory
await session.exec('export API_KEY=x'); // Set environment variable
await session.exec('node server.js'); // Should run in /app with API_KEY set
```

The naive approach would be to spawn a new shell for each command. But then every command starts fresh - the `cd` is forgotten, the `export` is lost. We need a **persistent shell** that stays alive across commands.

### Problem 2: stdout/stderr Separation

When a command runs, it produces two output streams: stdout (normal output) and stderr (errors). We need to capture both separately so the user gets:

```typescript
result.stdout; // "Hello world"
result.stderr; // "Warning: deprecated API"
```

But we only have one shell. Both streams come out of the same process. How do we know which bytes are stdout and which are stderr? We need a way to **label each line** with its source stream, then reconstruct them later.

### Problem 3: Completion Detection

When we send a command to the bash shell, how does our TypeScript code know when it's finished?

There's no built-in "command finished" signal. Bash just... keeps running. We can't use the shell's exit (we want it to stay alive for the next command). We need a **reliable signal** that a specific command completed, along with its exit code.

### Problem 4: Process Tree Cleanup

When the user starts a background process and later wants to kill it:

```typescript
const server = await sandbox.startProcess('./start-server.sh');
// ... later ...
await server.kill();
```

The problem: that shell script might spawn child processes:

```bash
# start-server.sh
python worker.py &    # Spawns a worker in the background
python worker.py &    # Another worker
python server.py      # Main server
```

Now we have a process tree:

```
bash (start-server.sh)
  ├── python (worker.py)
  ├── python (worker.py)
  └── python (server.py)
```

If we just `kill(bash_pid)`, the bash process dies - but the python processes keep running! They become "orphans" and get adopted by the init process (PID 1). We've lost control of them.

We need to **kill the entire process tree** - the parent and all its descendants.

### Problem 5: Concurrent Command Serialization

What if two requests try to run commands in the same session simultaneously?

```typescript
// Request 1
session.exec('cd /app && npm install'); // Takes 30 seconds

// Request 2 (arrives while Request 1 is running)
session.exec('npm run build'); // Where does this run? What's the cwd?
```

If commands interleave, state becomes unpredictable. We need to **serialize commands within a session** so they run one at a time, in order.

---

Every design decision in the codebase traces back to solving one of these five problems.

---

## 3. Bash Crash Course

### Subshells vs Group Commands

Bash has two ways to group commands that look similar but behave very differently:

```bash
# Subshell ( ) - runs in a CHILD process
( cd /tmp && export FOO=bar )
pwd        # Still in original directory!
echo $FOO  # Empty! FOO was set in child, child is now dead

# Group command { } - runs in the CURRENT shell
{ cd /tmp && export FOO=bar; }
pwd        # Now in /tmp
echo $FOO  # "bar"
```

**The difference**: Parentheses `( )` create a child process (subshell). When it exits, all its state disappears. Curly braces `{ }` run in the current shell, so `cd` and `export` persist.

**How we use this**:

- Foreground commands use `{ }` so state persists
- Background commands use `( ) &` because we don't want them affecting the main shell

### FIFOs (Named Pipes)

A FIFO is a special file that acts as a pipe between processes. Unlike regular files, data doesn't get stored - it flows directly from writer to reader.

```bash
mkfifo /tmp/my.pipe   # Create a named pipe (looks like a file, but isn't)

# Terminal 1: Write to the pipe
echo "hello" > /tmp/my.pipe
# This BLOCKS! It waits until someone reads from the other end.

# Terminal 2: Read from the pipe
cat /tmp/my.pipe
# Prints "hello", and Terminal 1 unblocks
```

**Key behaviors**:

- **Writing blocks** until someone reads (or the pipe fills up)
- **Reading blocks** until data arrives
- When all writers close the FIFO, readers get EOF (end-of-file)
- Unlike regular pipes (`cmd1 | cmd2`), FIFOs persist on disk and must be deleted when done

**How we use this**: Background commands write stdout/stderr to FIFOs. "Labeler" processes read from the FIFOs and add prefixes. This lets us stream output in real-time while the command runs.

### Exit Codes and $?

Every command in bash exits with a numeric code. `0` means success, anything else means failure.

```bash
ls /exists       # This succeeds
echo $?          # Prints "0"

ls /nonexistent  # This fails (directory doesn't exist)
echo $?          # Prints "2" (the error code for "not found")

echo "hi"        # This succeeds
echo $?          # Prints "0" - $? changed! It's always the LAST command's exit code
```

**The trap**: `$?` only holds the exit code of the **most recent** command. If you run anything else before checking it, you've lost it. That's why in our scripts we immediately capture it: `EXIT_CODE=$?`

### The /proc Filesystem

On Linux, the kernel exposes process information as a virtual filesystem at `/proc`. Every running process gets a directory:

```bash
cat /proc/1234/task/1234/children
# Output: "5678 5679 5680"
# These are the PIDs of processes that 1234 spawned
```

This is a read-only view into the kernel's process table. We use it to find all descendants of a process when we need to kill an entire process tree.

---

## 4. Foreground Execution: `exec()`

### The Goal

We want this to work:

```typescript
await session.exec('cd /app');
await session.exec('export DB_HOST=localhost');
await session.exec('node server.js'); // Must see /app as cwd, DB_HOST in env
```

Each command should see the state left by previous commands. The `cd` must persist. The `export` must persist.

### The Solution: Temp Files + Synchronous Prefixing

```
┌─────────────┐
│   Command   │ ──stdout──▶ log.stdout (temp file)
│   { ... }   │ ──stderr──▶ log.stderr (temp file)
└─────────────┘
       │ $?
       ▼
Then: Read temp files, prefix each line, merge into log file
Then: Write exit code atomically (via rename)
Then: Shell continues (state persists!)
```

The command runs inside `{ }` (group command) in the main shell, so `cd` and `export` affect subsequent commands. Output goes to temporary files, which we read after the command finishes.

**Why temp files instead of FIFOs?**

If we used FIFOs for foreground (like we do for background), we'd need background labeler processes to read from the FIFOs and write to the log file. Here's the problem with that:

```
FIFO approach (problematic):

Timeline:
1. Command runs, writes to FIFOs          ───────────────▶
2. Labelers read FIFOs, write to log      ─────────────────────▶ (async!)
3. Exit code written                      ────────────────▶
4. TypeScript sees exit code, reads log   ─────────────────▶
                                                         ^
                                          RACE CONDITION: log might not be complete yet!
```

The labelers run asynchronously. When the command finishes and writes its exit code, the labelers might still be processing output. TypeScript sees the exit code, tries to read the log file, and gets incomplete data.

With temp files, everything is **synchronous**:

```
Temp file approach (what we use):

Timeline:
1. Command runs, writes to temp files     ───────────────▶ (bash waits for write to complete)
2. Read temp files, prefix, write to log  ───────────────▶ (runs in main shell, blocks)
3. Exit code written                      ───▶
4. TypeScript sees exit code, reads log   ───▶
                                              ^
                                              Log is GUARANTEED complete before exit code exists
```

Steps 1 and 2 happen sequentially in the main shell. The exit code is only written AFTER the log file is fully written. No race condition possible.

### The Generated Bash Script

When you call `session.exec('echo hello')`, we generate and send this bash script to the shell:

```bash
{
  log='/tmp/session-abc/cmd123.log'

  # Execute the command, capturing stdout and stderr to temp files
  {
    echo hello        # <-- The user's command goes here
    EXIT_CODE=$?      # Capture the exit code immediately (before it changes)
  } < /dev/null > "$log.stdout" 2> "$log.stderr"
  #   ^^^^^^^^^^   ^^^^^^^^^^^^^    ^^^^^^^^^^^^^^
  #   Empty stdin  stdout to file   stderr to file

  # Now read the temp files and prefix each line
  # \x01\x01\x01 marks stdout lines, \x02\x02\x02 marks stderr lines
  (while IFS= read -r line || [[ -n "$line" ]]; do
    printf '\x01\x01\x01%s\n' "$line"
  done < "$log.stdout" >> "$log") 2>/dev/null

  (while IFS= read -r line || [[ -n "$line" ]]; do
    printf '\x02\x02\x02%s\n' "$line"
  done < "$log.stderr" >> "$log") 2>/dev/null

  rm -f "$log.stdout" "$log.stderr"  # Clean up temp files

  # Write exit code atomically using the rename trick
  echo "$EXIT_CODE" > '/tmp/session-abc/cmd123.exit.tmp'
  mv '/tmp/session-abc/cmd123.exit.tmp' '/tmp/session-abc/cmd123.exit'
  # ^^ rename is atomic on POSIX - readers never see partial content
}
```

**Walking through it**:

1. **Why the outer `{ }`?** We need to:
   - Redirect stdout AND stderr of the whole command (not just part of it)
   - Capture the exit code after the command finishes
   - Redirect stdin from `/dev/null`

   Without braces, if the user's command is `cd /app && npm install`, the redirection would only apply to `npm install`, not to `cd`. The braces group everything so the redirects apply to the entire command.

   And importantly, `{ }` is a group command (not a subshell), so `cd`, `export`, etc. still affect the main shell.

2. **Output redirection** - `> "$log.stdout" 2> "$log.stderr"` sends stdout and stderr to separate temp files. Bash waits for all writes to complete before continuing.

3. **Prefixing and merging** - We read each temp file line-by-line, prepend a binary marker, and append to a **single combined log file**. TypeScript only reads this one file. The prefixes (`\x01\x01\x01` for stdout, `\x02\x02\x02` for stderr) let us reconstruct the separate streams later.

   Why not just have TypeScript read the two temp files directly? Because we want a consistent format - both foreground and background modes produce the same single-file-with-prefixes format. This simplifies the TypeScript side.

4. **Atomic exit code** - We write to a `.tmp` file, then rename. The `mv` operation is atomic on POSIX filesystems - TypeScript never sees a partial/corrupt exit code file.

### TypeScript: Waiting for Completion

How does our TypeScript code know when bash has finished executing the command? We wait for the exit code file to appear:

```typescript
// session.ts - waitForExitCode()
private async waitForExitCode(exitCodeFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Method 1: fs.watch - Fast, but unreliable
    // On some filesystems (tmpfs, overlayfs), watch misses rename events
    const watcher = watch(dir, async (_, changedFile) => {
      if (resolved) return;
      if (changedFile === filename) {
        resolved = true;
        watcher.close();
        clearInterval(pollInterval);
        const exitCode = await Bun.file(exitCodeFile).text();
        resolve(parseInt(exitCode.trim(), 10));
      }
    });

    // Method 2: Polling - Reliable, but slower
    // Check every 50ms if the file exists
    const pollInterval = setInterval(async () => {
      if (resolved) return;
      if (await Bun.file(exitCodeFile).exists()) {
        resolved = true;
        watcher.close();
        clearInterval(pollInterval);
        const exitCode = await Bun.file(exitCodeFile).text();
        resolve(parseInt(exitCode.trim(), 10));
      }
    }, 50);

    // Method 3: Timeout - Prevent infinite hangs
    if (this.commandTimeoutMs !== undefined) {
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          watcher.close();
          clearInterval(pollInterval);
          reject(new Error(`Command timeout after ${this.commandTimeoutMs}ms`));
        }
      }, this.commandTimeoutMs);
    }
  });
}
```

**Why use both watch AND polling?**

`fs.watch` is fast - we get notified immediately when the file appears. But it's unreliable on certain filesystems (tmpfs, overlayfs) where it misses `rename` events.

Polling is reliable - we directly check if the file exists. But polling at 50ms intervals adds latency.

We use both: watch for speed, polling as a fallback. Whichever detects the file first wins.

---

## 5. Background Execution: `execStream()` / `startProcess()`

### The Goal

We want to run long-lived processes that we can monitor and kill:

```typescript
const server = await sandbox.startProcess('npm run dev');

// Stream logs while server runs
for await (const event of server.streamLogs()) {
  console.log(event.data); // See output in real-time
}

// Kill it later (along with all child processes)
await server.kill();
```

This is fundamentally different from `exec()`:

- **exec()**: Run command, wait for it to finish, return result
- **startProcess()**: Start command, return immediately, stream output, kill later

We can't use the foreground approach here because:

1. We need to stream output **while the command runs**, not after
2. We need to capture the **PID** so we can kill it later
3. We **don't want state to persist** (a background server shouldn't change the cwd)

### The Solution: FIFOs + Labelers + Monitor

```
┌─────────────┐
│   Command   │ ──stdout──▶ ┌──────────────┐     ┌─────────────┐
│  { ... } &  │             │ stdout.pipe  │ ──▶ │ Labeler r1  │ ──┐
│  (subshell) │ ──stderr──▶ ├──────────────┤     ├─────────────┤   │
└─────────────┘             │ stderr.pipe  │ ──▶ │ Labeler r2  │ ──┼──▶ log file
      │                     └──────────────┘     └─────────────┘   │
      │ $!                       FIFOs         (add \x01 / \x02    │
      ▼                                          prefix to lines)  │
   PID file                                                        │
                                                                   │
Background monitor: waits for labelers to finish, deletes FIFOs ───┘
```

**How this works**:

1. We create two FIFOs (named pipes) - one for stdout, one for stderr
2. We start two "labeler" processes that read from the FIFOs and prefix each line
3. We run the user's command in the background (`&`), redirecting to the FIFOs
4. The shell returns immediately - it doesn't wait for the command to finish
5. We capture the PID using `$!` (the PID of the last backgrounded process)
6. TypeScript can read the log file while the command is still running
7. When the command exits, it closes the FIFOs, labelers get EOF and exit
8. A monitor process cleans up the FIFOs after labelers finish

### The Generated Bash Script

```bash
{
  log='/tmp/session-abc/cmd456.log'
  sp='/tmp/session-abc/cmd456.stdout.pipe'
  ep='/tmp/session-abc/cmd456.stderr.pipe'

  # Step 1: Create the FIFOs
  rm -f "$sp" "$ep" && mkfifo "$sp" "$ep" || exit 1

  # Step 2: Start labelers (they read from FIFOs and prefix lines)
  # Each labeler runs in the background, waiting for data
  (while IFS= read -r line || [[ -n "$line" ]]; do
    printf '\x01\x01\x01%s\n' "$line"
  done < "$sp") >> "$log" & r1=$!   # Labeler for stdout, save its PID as r1

  (while IFS= read -r line || [[ -n "$line" ]]; do
    printf '\x02\x02\x02%s\n' "$line"
  done < "$ep") >> "$log" & r2=$!   # Labeler for stderr, save its PID as r2

  # Step 3: Run the user's command in the background
  {
    npm run dev         # <-- The user's command
    CMD_EXIT=$?
    echo "$CMD_EXIT" > '/tmp/session-abc/cmd456.exit.tmp'
    mv '/tmp/session-abc/cmd456.exit.tmp' '/tmp/session-abc/cmd456.exit'
  } < /dev/null > "$sp" 2> "$ep" & CMD_PID=$!
  #                ^^^^     ^^^^   ^^^^^^^^^
  #             stdout→FIFO stderr→FIFO  capture PID

  # Step 4: Write PID to file so TypeScript can kill it later
  echo "$CMD_PID" > '/tmp/session-abc/cmd456.pid.tmp'
  mv '/tmp/session-abc/cmd456.pid.tmp' '/tmp/session-abc/cmd456.pid'

  # Step 5: Background monitor - waits for labelers, then cleans up
  (
    wait "$r1" "$r2" 2>/dev/null   # Wait for both labelers to exit
    rm -f "$sp" "$ep"              # Delete the FIFOs
    touch '/tmp/session-abc/cmd456.labelers.done'  # Signal completion
  ) &
}
# Shell returns here immediately - doesn't wait for command to finish!
```

**Walking through it**:

1. **Create FIFOs** - Two named pipes, one for each output stream

2. **Start labelers** - These background processes read from the FIFOs. They block waiting for data. When data arrives, they prefix it and append to the log file.

3. **Run the command** - The user's command runs in a subshell (`{ ... } &`), backgrounded. Its stdout goes to one FIFO, stderr to the other. We capture the PID with `$!`.

4. **Save the PID** - Written atomically to a file so TypeScript can read it and later kill the process.

5. **Monitor process** - Waits for both labelers to finish (which happens when the command exits and closes the FIFOs), then cleans up.

6. **Shell returns immediately** - Unlike foreground mode, the shell doesn't wait. This is what lets us stream output while the command runs.

### Process Tree Killing

When the user calls `process.kill()`, we need to kill not just the main process, but all its children too.

**The problem with naive kill**:

```
bash(1000)          # start-server.sh
  ├── python(1001)  # worker.py
  ├── python(1002)  # worker.py
  └── python(1003)  # server.py

process.kill(1000)  →  bash dies, but the python processes keep running!
                       They get "orphaned" and adopted by init (PID 1)
```

**The solution**: Walk the process tree depth-first, killing children before parents.

```typescript
// session.ts - killCommand()
const killTree = (targetPid: number, signal: NodeJS.Signals) => {
  try {
    // Read this process's children from /proc
    const childrenFile = `/proc/${targetPid}/task/${targetPid}/children`;
    const children = readFileSync(childrenFile, 'utf8').trim().split(/\s+/);

    // Recursively kill children FIRST
    for (const childPid of children.filter(Boolean)) {
      killTree(parseInt(childPid, 10), signal);
    }
  } catch {
    // Process already exited, or /proc not available
  }

  // Then kill this process
  try {
    process.kill(targetPid, signal);
  } catch {
    // Process already exited
  }
};
```

**Why depth-first (children before parent)?**

If we kill the parent first, its children become orphans. The Linux kernel immediately re-parents orphans to init (PID 1). Once that happens, we've lost track of them - they're no longer in our process tree.

By killing children first, we ensure we get them while we still know they exist.

**The kill sequence**:

```typescript
// First try SIGTERM - give processes a chance to clean up gracefully
killTree(pid, 'SIGTERM');

// Wait up to 5 seconds for graceful exit
await Promise.race([
  this.waitForExitCode(exitCodeFile),
  new Promise((_, reject) => setTimeout(() => reject(), 5000))
]).catch(() => {
  // Timeout - escalate to SIGKILL (force kill, no cleanup)
  killTree(pid, 'SIGKILL');
});
```

---

## 6. The Concurrency Model

Remember Problem 5: what happens when multiple requests try to run commands in the same session simultaneously?

### Per-Session Mutexes

The solution is a mutex (lock) for each session:

```typescript
// session-manager.ts
export class SessionManager {
  private sessions = new Map<string, Session>();
  private sessionLocks = new Map<string, Mutex>(); // One mutex PER SESSION

  async executeInSession(sessionId: string, command: string): Promise<Result> {
    const lock = this.getSessionLock(sessionId);

    // Only one command runs at a time within this session
    return lock.runExclusive(async () => {
      const session = await this.getOrCreateSession(sessionId);
      return session.exec(command);
    });
  }
}
```

**What this guarantees**:

- Commands in the **same session** are serialized - they run one at a time, in order
- Commands in **different sessions** can run in parallel - each session has its own mutex

This matches user expectations: within one session, commands should see each other's state changes in order. Across sessions, they're isolated anyway, so parallelism is fine.

### Background Mode: Early Lock Release

Here's a problem: if you start a web server with `startProcess()`, it might run for hours. We can't hold the session lock that entire time - no other commands could run in that session!

The solution: for background processes, we release the lock **after the process starts**, not when it finishes.

```typescript
// session-manager.ts - executeStreamInSession()

if (background) {
  // BACKGROUND: Release lock after 'start' event
  const startupResult = await lock.runExclusive(async () => {
    const session = await this.getOrCreateSession(sessionId);
    const generator = session.execStream(command);

    // Wait for the 'start' event (which includes the PID)
    const firstResult = await generator.next();
    await onEvent(firstResult.value); // 'start' event

    return { generator };
  });
  // ← Lock is released HERE, right after 'start'

  // Continue streaming WITHOUT the lock
  const continueStreaming = (async () => {
    for await (const event of startupResult.generator) {
      await onEvent(event);
    }
  })();

  return { continueStreaming };
} else {
  // FOREGROUND STREAMING: Hold lock until complete
  return lock.runExclusive(async () => {
    const session = await this.getOrCreateSession(sessionId);
    for await (const event of session.execStream(command)) {
      await onEvent(event);
    }
  });
}
```

**Why the difference?**

- **Background** (`startProcess`): The process might run for hours. We just need the lock long enough to start it and get the PID. After that, other commands can run.

- **Foreground streaming** (`execStream`): The user is actively watching output. We hold the lock until the command completes to prevent other commands from interleaving.

### Kill Bypasses the Lock

One special case: killing a process does NOT acquire the session lock.

```typescript
async killCommand(sessionId: string, commandId: string): Promise<Result> {
  // NO LOCK! Kill must work even if another command is running
  const session = await this.getSession(sessionId);
  return session.killCommand(commandId);
}
```

Why? Imagine a command is stuck in an infinite loop. The lock is held. If `kill()` needed the lock, we'd deadlock - we couldn't kill the stuck command because it holds the lock.

Kill signals go directly to the process via the OS. They don't need to go through bash or wait for the session.

---

## 7. The Full Request Flow

Here's what happens when you call `sandbox.exec('echo hello')`:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Your Worker Code                             │
│   const result = await sandbox.exec('echo hello');                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Sandbox Durable Object                            │
│   packages/sandbox/src/sandbox.ts                                    │
│                                                                      │
│   Manages container lifecycle, holds session state, routes to HTTP   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                │ HTTP POST /api/execute
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Container HTTP Server (Bun)                       │
│   packages/sandbox-container/src/handlers/execute-handler.ts         │
│                                                                      │
│   Receives HTTP request, parses body, calls ProcessService           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        ProcessService                                │
│   packages/sandbox-container/src/services/process-service.ts         │
│                                                                      │
│   Business logic layer - delegates to SessionManager                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       SessionManager                                 │
│   packages/sandbox-container/src/services/session-manager.ts         │
│                                                                      │
│   Acquires mutex for the session, then calls Session.exec()          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Session                                     │
│   packages/sandbox-container/src/session.ts                          │
│                                                                      │
│   Generates bash script, writes to shell stdin, waits for exit code, │
│   parses log file to extract stdout/stderr                           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Persistent Bash Shell                          │
│   bash --norc (spawned once per session, kept alive)                 │
│                                                                      │
│   Receives script via stdin, executes it, writes exit code to file   │
└─────────────────────────────────────────────────────────────────────┘
```

### Summary of Each Layer

| Layer           | File                 | What It Does                                            |
| --------------- | -------------------- | ------------------------------------------------------- |
| **Sandbox DO**  | `sandbox.ts`         | Public API. Manages container lifecycle and sessions.   |
| **HTTP Client** | `command-client.ts`  | Makes HTTP requests to the container.                   |
| **Handler**     | `execute-handler.ts` | Receives HTTP requests, routes to services.             |
| **Service**     | `process-service.ts` | Business logic. Orchestrates command execution.         |
| **Manager**     | `session-manager.ts` | Mutex serialization. One command at a time per session. |
| **Session**     | `session.ts`         | The core. Generates bash scripts, manages the shell.    |

---

## Summary

**Why two execution modes?**

Because of a fundamental trade-off. Foreground commands run in the main shell so state persists, but you can't stream output or kill them mid-execution. Background commands run in a subshell so you can stream and kill them, but state doesn't persist back to the main shell.

**Why temp files for foreground, FIFOs for background?**

File redirects are synchronous - bash waits for all writes to complete. FIFO writes are asynchronous - bash can continue while data is still buffering. With large outputs, FIFOs cause race conditions. Temp files don't.

But FIFOs let us stream in real-time while a command runs, which temp files can't do. So we use temp files for foreground (where we need synchronous completion) and FIFOs for background (where we need streaming).

**Why binary prefixes?**

We need to separate stdout and stderr, but they come from the same shell. We prefix each line with `\x01\x01\x01` (stdout) or `\x02\x02\x02` (stderr), multiplex them into one log file, then parse them apart later.

**Why hybrid exit detection?**

`fs.watch` is fast but misses rename events on some filesystems. Polling is reliable but adds latency. We use both - whichever detects the exit code file first wins.

**Why depth-first process tree killing?**

If we kill a parent before its children, the children become orphans and get adopted by init (PID 1). We lose track of them. By killing children first, we ensure we get the entire tree.

**Why per-session mutexes?**

Commands in the same session need to see each other's state changes in order, so they must run sequentially. Commands in different sessions are isolated anyway, so they can run in parallel. One mutex per session gives us both.

---

## Further Reading

- `docs/SESSION_EXECUTION.md` - Architecture decisions and trade-offs
- `docs/CONCURRENCY.md` - Full concurrency model across all layers
- `packages/sandbox-container/src/session.ts` - Implementation with detailed comments
- `packages/sandbox-container/tests/session.test.ts` - Unit tests showing behavior
