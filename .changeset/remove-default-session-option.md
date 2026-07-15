---
'@cloudflare/sandbox': minor
---

Top-level execution is now stateless by default. `exec()`, `startProcess()`, file, watch, git, and backup calls no longer reuse a hidden default session; pass an explicit `sessionId` or `sandbox.createSession()` when commands need to share shell state. The temporary `enableDefaultSession` option has been removed from `SandboxOptions`. Process reads use `listProcesses({ sessionId })` / `getProcess(id, { sessionId })`, and process kill methods no longer accept signal arguments.

Streaming command execution has moved to `startProcess()` — `execStream()` and `exec({ stream, onOutput, onComplete, onError, signal })` are removed. Interactive terminals are now explicit resources: use `sandbox.terminal({ id, cwd, shell }).connect(request, { cols, rows })` instead of the removed `ExecutionSession.terminal()`.
