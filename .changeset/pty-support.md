---
'@cloudflare/sandbox': patch
---

Add terminal support for browser-based terminal UIs.

Build interactive terminal experiences by connecting xterm.js to container PTYs via WebSocket. Terminals reconnect automatically with output history preserved, and each session gets its own isolated terminal.

```typescript
// Proxy WebSocket to container terminal
return sandbox.terminal(request, { cols: 80, rows: 24 });

// Multiple isolated terminals in the same sandbox
const session = await sandbox.getSession('dev');
return session.terminal(request);
```

Also exports `@cloudflare/sandbox/xterm` with a `SandboxAddon` for xterm.js — handles WebSocket connection, reconnection with exponential backoff, and terminal resize forwarding.

```typescript
import { SandboxAddon } from '@cloudflare/sandbox/xterm';

const addon = new SandboxAddon({
  getWebSocketUrl: ({ sandboxId, origin }) =>
    `${origin}/ws/terminal?id=${sandboxId}`
});
terminal.loadAddon(addon);
addon.connect({ sandboxId: 'my-sandbox' });
```
