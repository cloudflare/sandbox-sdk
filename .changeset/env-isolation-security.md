---
"@cloudflare/sandbox": minor
---

Add process isolation for sandbox commands

Implements PID namespace isolation to protect control plane processes (Jupyter, Bun) from sandboxed code. Commands executed via `exec()` now run in isolated namespaces that cannot see or interact with system processes.

**Key security improvements:**
- Control plane processes are hidden from sandboxed commands
- Platform secrets in `/proc/1/environ` are inaccessible
- Ports 8888 (Jupyter) and 3000 (Bun) are protected from hijacking

**Important behavior change:** Commands within the same session now maintain state (working directory, environment variables, background processes). Previously each command was stateless.

```javascript
// Before: each exec was independent
await sandbox.exec("cd /app");
await sandbox.exec("pwd"); // Output: /workspace

// After: state persists in session
await sandbox.exec("cd /app");
await sandbox.exec("pwd"); // Output: /app
```

**Migration notes:**
- If you need isolated commands, create separate sessions with `sandbox.createSession()`
- Environment variables set in one command persist to the next
- Background processes remain active until explicitly killed
- Requires CAP_SYS_ADMIN (available in production, falls back gracefully in dev)