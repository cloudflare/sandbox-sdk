# Process Execution

The Sandbox is the long-running computer. It is not a hidden shell and `exec()` does not preserve shell state between launches.

## Launch model

```ts
const process = await sandbox.exec(['python3', '-c', 'print(2 + 2)']);
const output = await process.output({ encoding: 'utf8' });

console.log(process.id, process.pid, output.stdout, output.exitCode);
```

- `exec(argv, options)` accepts argv only. The executable in `argv[0]` must be non-empty; later arguments may be empty strings. Shell syntax is explicit: `['/bin/bash', '-lc', script]`.
- `await sandbox.exec(argv)` waits for launch, not completion. The returned handle exposes the process ID and numeric PID.
- `status()` observes the current discriminated state; `output()`, `waitForExit()`, and `exitCode` wait for completion.
- A process remains `running` until its complete supervised process group has settled, even if the root subprocess exits while a descendant continues.
- Terminal exit codes and signals describe the outcome observed for the root subprocess. Signals delivered only to descendants do not rewrite that outcome.
- `output()` buffers replayable stdout/stderr and may return `truncated: true`.
- `logs({ since, replay, follow })` streams replayable cursor events and supports output too large to buffer.
- `kill(signal)` sends a numeric signal and defaults to signal 15.
- `exec(argv, { timeout })` sets a remote process lifetime deadline: the supervisor may terminate and then kill the process internally, and completion is reported with `timedOut: true`.
- Timeouts and `AbortSignal`s on `logs()`, `output()`, `waitForExit()`, `waitForLog()`, and `waitForPort()` cancel only that caller's local observation. They never kill or otherwise control the process.
- Asynchronous callers store `process.id`, return to the user, and later recover with `sandbox.getProcess(id)`.
- `getProcess()` and `listProcesses()` do not wake a sleeping Sandbox. With no active runtime they return `null` and `[]`.
- `cwd` is selected per launch. Each process and terminal inherits the complete container environment, then applies `env` as an overlay. The overlay does not mutate later launches; the execution layer intentionally does not curate inherited variables because commands share the Sandbox trust boundary.
- Active processes and terminals pin the live Sandbox so work can continue after the Worker request ends.
- Handles, IDs, PIDs, statuses, logs, and cursors belong to one runtime. After sleep, restart, or replacement, discovery cannot recover them and an old handle fails with `STALE_PROCESS_HANDLE` instead of controlling a replacement runtime.

## Logs and cursors

```ts
const process = await sandbox.exec(['/bin/bash', '-lc', 'npm test']);
const previousCursor = 'cursor-from-earlier-stream';

const recovered = await sandbox.getProcess(process.id);
if (recovered) {
  const stream = await recovered.logs({
    since: previousCursor,
    replay: true,
    follow: true
  });
}
```

Retain the cursor from the latest delivered log event when a client disconnects and resume from that cursor in a later request. Cancel or release each stream when the caller stops reading; cancellation closes that observation subscription but leaves the process running.

## Terminals

Use a terminal when the workload needs a persistent interactive shell, terminal control sequences, or reconnectable PTY state.

```ts
const terminal = await sandbox.createTerminal({
  command: ['/bin/bash'],
  cwd: '/workspace',
  env: { TERM: 'xterm-256color' }
});

const sameTerminal = await sandbox.getTerminal(terminal.id);
```

Terminals are separate from `exec()`: they own PTY input, resize, interrupt, terminate, cursor replay, and reconnect behavior, while processes own supervised argv launches, numeric signals, output, and log cursors. Do not infer terminal control semantics from process handles.

Natural terminal completion waits for both the root subprocess outcome and Bun's PTY EOF so buffered output is delivered before the terminal event. A descendant that retains the PTY keeps the terminal active until it exits or the caller explicitly closes the terminal. There is intentionally no timeout fallback: if Bun never reports EOF, natural completion remains pending until explicit close rather than risk truncating buffered PTY output.

## Coding-agent harnesses

### Pi

```ts
const proc = await sandbox.exec(['/bin/bash', '-lc', piScript], {
  cwd: '/workspace',
  env: { PI_DISABLE_TELEMETRY: '1' }
});
await proc.waitForLog(/ready|listening/i, { timeout: 30_000 });
return { processId: proc.id };
```

A later Worker request calls `sandbox.getProcess(processId)` and resumes logs with the saved cursor.

### Codex

```ts
const proc = await sandbox.exec(['/bin/bash', '-lc', codexCommand], {
  cwd: '/workspace',
  env: { HOME: '/workspace' }
});
const result = await proc.output({ encoding: 'utf8' });
```

Use explicit Bash argv for shell setup and collect output from the process handle.

### OpenCode

```ts
const server = await sandbox.exec(
  ['/bin/bash', '-lc', 'opencode serve --host 0.0.0.0'],
  {
    cwd: '/workspace'
  }
);
await server.waitForPort(4096, { timeout: 60_000 });
```

Store `server.id` for shutdown or log recovery from another Worker request. Use a terminal instead when attaching a human interactive shell.
