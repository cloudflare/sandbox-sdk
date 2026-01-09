---
'@cloudflare/sandbox': minor
---

Add PTY (pseudo-terminal) support for interactive terminal sessions.

New `sandbox.pty` namespace with:

- `create()` - Create a new PTY session
- `attach(sessionId)` - Attach PTY to existing session
- `getById(id)` - Reconnect to existing PTY
- `list()` - List all PTY sessions

PTY handles support:

- `write(data)` - Send input
- `resize(cols, rows)` - Resize terminal
- `kill()` - Terminate PTY
- `onData(cb)` - Receive output
- `onExit(cb)` - Handle exit
- `exited` - Promise for exit code
- Async iteration for scripting

Example:

```typescript
const pty = await sandbox.pty.create({ cols: 80, rows: 24 });
pty.onData((data) => terminal.write(data));
pty.write('ls -la\n');
```
