---
'@cloudflare/sandbox': minor
---

Add terminal support for browser-based terminal UIs.

Build interactive terminal experiences by connecting xterm.js to container PTYs via WebSocket. Terminals reconnect automatically with output history preserved, and each session gets its own isolated terminal.

```typescript
// Proxy WebSocket to container terminal
return sandbox.terminal(request, { cols: 80, rows: 24 });

// Session-scoped terminals
const session = await sandbox.getSession('dev');
return session.terminal(request);
```

Also exports `@cloudflare/sandbox/xterm` addon for easy xterm.js integration.
