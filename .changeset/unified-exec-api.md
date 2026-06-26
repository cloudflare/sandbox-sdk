---
'@cloudflare/sandbox': minor
---

Unify command execution around a Containers-style `sandbox.exec()` process handle with streaming stdout/stderr, stdin support, process re-attach, and `.output()` / `.text()` / `.json()` helpers. Existing buffered command code should migrate from `await sandbox.exec(cmd)` to `await sandbox.exec(cmd).output()`; use `sandbox.run(cmd)` when you need the previous persistent-shell buffered behavior.
