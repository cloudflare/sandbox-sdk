---
'@cloudflare/sandbox': patch
---

Support per-command and per-session timeouts for exec

Timeouts now propagate correctly through the full stack. Per-command `timeout` on `exec()` takes priority over session-level `commandTimeoutMs` set via `createSession()`, which takes priority over the container-level `COMMAND_TIMEOUT_MS` environment variable.
