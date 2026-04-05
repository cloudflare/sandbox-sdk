---
'@cloudflare/sandbox': patch
---

Fix deadlock in WebSocket transport when the container requires a cold start.

When a `Sandbox` subclass performs I/O inside its `onStart()` lifecycle hook
(e.g., calling `exec()`), the container could get stuck in an infinite failure
loop during cold starts. Requests made during WebSocket connection setup now
complete normally via a direct HTTP fallback, keeping the sandbox responsive.
