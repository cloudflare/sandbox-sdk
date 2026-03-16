---
'@cloudflare/sandbox': patch
---

Fix WebSocket sandboxes getting stuck after a dropped control connection. Repeated operations now reconnect automatically, and repeated `getSandbox()` calls in the same Worker isolate avoid re-sending unchanged setup RPCs.
