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

The SDK now models shell death as a first-class error:

- The call that terminates the shell returns a new `SessionTerminatedError`
  (`SESSION_TERMINATED`, HTTP 410) with the observed exit code. Callers learn
  that session-local state (env vars, cwd, shell functions, background jobs) is
  gone rather than silently running commands against a fresh shell.
- The dead handle is evicted on the way out, so the next call on the same
  session id transparently starts a fresh session.
- `createSession({ id })` on a dead session id now replaces the dead handle
  instead of returning `SESSION_ALREADY_EXISTS`, giving callers a deterministic
  recovery API.
