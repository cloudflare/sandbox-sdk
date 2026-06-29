---
'@cloudflare/sandbox': minor
---

Remove hidden default-session routing from top-level sandbox APIs. Top-level `exec()`, `startProcess()`, file, watch, git, and backup operations now run without persistent shell state unless you pass an explicit `sessionId`; use `sandbox.createSession()` when commands or file operations need to share state. Session IDs now live in options objects across command, process, file, git, and backup APIs, process reads use `listProcesses({ sessionId })` / `getProcess(id, { sessionId })`, and process kill methods no longer accept unsupported signal arguments.
