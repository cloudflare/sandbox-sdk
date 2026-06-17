# Session Execution Deep Dive

For the current architecture summary, start with
[`SESSION_EXECUTION.md`](./SESSION_EXECUTION.md). This document expands on the
main design boundaries and the reasons behind them.

## The API Split

The SDK exposes separate resources because Unix process and terminal semantics
are separate:

```ts
await sandbox.exec('npm test');

const process = await sandbox.startProcess('npm run dev');
await process.kill();

const session = await sandbox.createSession({ cwd: '/workspace/app' });
await session.exec('export NODE_ENV=test');
await session.exec('npm install');
const server = await session.startProcess('npm run dev');

const terminal = sandbox.terminal({ id: 'main', cwd: '/workspace/app' });
await terminal.connect(request, { cols: 120, rows: 40 });
await terminal.destroy();
```

The important distinction is not implementation style. It is the promise each
resource can honestly make:

- `exec()` returns a completed result.
- `startProcess()` returns a lifecycle-managed process.
- `createSession()` creates persistent shell state for structured commands.
- `terminal()` creates an interactive PTY resource.

## Why Top-Level `exec()` Is Stateless

Top-level `sandbox.exec()` behaves like a one-shot shell command. It does not
create or reuse a persistent shell. That avoids hidden state surprises such as a
previous `cd` or `export` changing later top-level commands.

Stateful behavior is explicit:

```ts
const session = await sandbox.createSession();
await session.exec('cd /workspace/project');
await session.exec('pwd'); // /workspace/project
```

The runtime primitive is `StatelessCommandRunner`, which applies only the
per-call `cwd`, `env`, and timeout options supplied by the caller.

## Why `session.exec()` Is Completion-Only

`session.exec()` runs in the persistent command-session shell. That is what makes
this work:

```ts
await session.exec('alias ll="ls -la"');
await session.exec('ll');
```

The same property makes recoverable cancellation and process lifecycle control
unsafe as a general `exec()` promise. Interrupting a command running in the main
shell can leave shell state ambiguous. So `session.exec()` returns only after the
command completes and does not expose streaming or `kill()`.

Use `session.startProcess()` when a command needs lifecycle control.

## How Persistent `exec()` Captures Output

The runtime sends an instrumented command to bash. The command runs in the main
shell and redirects stdout and stderr to command-specific files:

```text
persistent bash shell
  -> run command in current shell
  -> stdout file
  -> stderr file
  -> completion frame / exit marker
  -> TypeScript reads final files
```

This design preserves shell state and avoids asynchronous output races. File
redirection completes before bash reports the command done, so TypeScript can
read complete stdout/stderr files after the completion marker.

## Why `startProcess()` Is Separate

Process resources need different guarantees:

- emit stdout/stderr while the command runs;
- expose a PID or process identity;
- support kill, timeout, and process-tree cleanup;
- preserve partial output after failure or cancellation;
- keep the parent session usable after the process exits or is killed.

A session process starts from inherited session state, but runs in its own
lifecycle boundary. It can see aliases, functions, cwd, and env that existed at
launch. Its later mutations do not write back to the parent command session.

## Event Flow for Session Processes

```text
session.startProcess(command)
  -> SessionManager.executeStreamInSession(...)
  -> RuntimeBackedSession.execRuntimeProcessStream(...)
  -> CommandSession.startProcess(...)
  -> start/stdout/stderr/complete events
  -> ProcessService record and SDK process handle
```

The container service layer owns existing process metadata and event shapes. The
execution package owns shell/process mechanics.

## Terminal Resources

Terminals are PTY resources. They are not command sessions and do not expose
structured stdout/stderr.

```text
terminals.createTerminal({ id, cwd, shell, cols, rows }) over RPC
/ws/terminal?terminalId=... for PTY bytes
terminals.destroyTerminal(id) over RPC
```

The WebSocket route is byte transport only. Terminal creation and destruction are
semantic lifecycle operations.

## Failure Boundaries

| Operation                | Failure behavior                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `sandbox.exec()`         | One-shot command fails or times out without persistent state cleanup concerns            |
| `session.exec()`         | Shell death terminates the command session; `SessionManager` can recreate on later calls |
| `sandbox.startProcess()` | Runtime terminates process tree on timeout/kill and preserves partial output             |
| `session.startProcess()` | Runtime terminates process tree without corrupting the parent command session            |
| `terminal.destroy()`     | PTY resource is closed independently of command sessions                                 |

## Contributor Checklist

When changing execution code, verify the API promise you are touching:

- Do not add streaming or cancellation back to `exec()`.
- Do not route terminal behavior through command sessions.
- Do not create hidden persistent sessions for top-level execution.
- Keep process lifecycle in `startProcess()` paths.
- Preserve shell-state tests for explicit sessions.
- Preserve process kill/timeout tests for `startProcess()`.

## Key Files

- [`packages/sandbox-execution/src/command-session.ts`](../packages/sandbox-execution/src/command-session.ts)
- [`packages/sandbox-execution/src/stateless-command-runner.ts`](../packages/sandbox-execution/src/stateless-command-runner.ts)
- [`packages/sandbox-execution/src/stateless-process-runner.ts`](../packages/sandbox-execution/src/stateless-process-runner.ts)
- [`packages/sandbox-container/src/services/session-manager.ts`](../packages/sandbox-container/src/services/session-manager.ts)
- [`packages/sandbox-container/src/services/process-service.ts`](../packages/sandbox-container/src/services/process-service.ts)
- [`packages/sandbox-container/src/services/terminal-manager.ts`](../packages/sandbox-container/src/services/terminal-manager.ts)
