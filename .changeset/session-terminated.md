---
'@cloudflare/sandbox': patch
---

Recover a sandbox session after its shell exits, instead of poisoning the sandbox.

Previously, if a session's underlying shell process exited — because a user
command ran `exit`, the shell crashed, or a child process took the shell down —
the sandbox kept returning the dead session handle. Every subsequent call threw
`Session is not ready or shell has died`, and `createSession` refused to replace
the dead session with `SESSION_ALREADY_EXISTS`. The only recovery path was
`sandbox.destroy()`, which loses `/workspace` state and forces a backup restore.

The SDK now models shell termination as a first-class error:

- The call that terminates the shell returns a new `SessionTerminatedError`
  (`SESSION_TERMINATED`, HTTP 410) with the observed exit code. Callers learn
  that session-local state (env vars, cwd, shell functions, background jobs) is
  gone rather than silently running commands against a fresh shell.
- The dead handle is evicted on the way out, so the next call on the same
  session id transparently starts a fresh session.
- `createSession({ id })` on a dead session id now replaces the dead handle
  instead of returning `SESSION_ALREADY_EXISTS`, giving callers a deterministic
  recovery API. The evict + recreate sequence runs entirely under the
  per-session lock, so it cannot race with a concurrent `executeInSession` or a
  concurrent second `createSession` and orphan a Session with a live bash PTY.
- Shell-death errors thrown from inside `withSession` callbacks (used by
  `setEnvVars`, `writeFile`, `readFile`, git clone, etc.) now surface as
  `SESSION_TERMINATED` and evict the dead handle eagerly, matching the behavior
  of `executeInSession`. Previously they leaked through as `INTERNAL_ERROR` and
  recovery was deferred to the next call.
