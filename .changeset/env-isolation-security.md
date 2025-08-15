---
"@cloudflare/sandbox": minor
---

Add process isolation for sandbox commands

Implements PID namespace isolation to protect control plane processes (Jupyter, Bun) from sandboxed code. Commands executed via `exec()` now run in isolated namespaces that cannot see or interact with system processes.

**Key security improvements:**
- Control plane processes are hidden from sandboxed commands
- Platform secrets in `/proc/1/environ` are inaccessible
- Ports 8888 (Jupyter) and 3000 (Bun) are protected from hijacking

**Breaking changes:**

1. **Removed `sessionId` parameter**: The `sessionId` parameter has been removed from all methods (`exec()`, `execStream()`, `startProcess()`, etc.). Each sandbox now maintains its own persistent session automatically.
   
   ```javascript
   // Before: manual session management
   await sandbox.exec("cd /app", { sessionId: "my-session" });
   
   // After: automatic session per sandbox
   await sandbox.exec("cd /app");
   ```

2. **Commands now maintain state**: Commands within the same sandbox now share state (working directory, environment variables, background processes). Previously each command was stateless.

   ```javascript
   // Before: each exec was independent
   await sandbox.exec("cd /app");
   await sandbox.exec("pwd"); // Output: /workspace
   
   // After: state persists in session
   await sandbox.exec("cd /app");
   await sandbox.exec("pwd"); // Output: /app
   ```

**Migration guide:**
- Remove `sessionId` from all method calls - each sandbox maintains its own session
- If you need isolated execution contexts within the same sandbox, use `sandbox.createSession()`:
  ```javascript
  // Create independent sessions with different environments
  const buildSession = await sandbox.createSession({
    name: "build",
    env: { NODE_ENV: "production" },
    cwd: "/build"
  });
  const testSession = await sandbox.createSession({
    name: "test", 
    env: { NODE_ENV: "test" },
    cwd: "/test"
  });
  ```
- Environment variables set in one command persist to the next
- Background processes remain active until explicitly killed
- Requires CAP_SYS_ADMIN (available in production, falls back gracefully in dev)