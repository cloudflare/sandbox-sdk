---
'@cloudflare/sandbox': patch
---

Fix startup deadlock when using WebSocket transport.

Sandboxes that call `exec()` or other SDK methods inside `onStart()` could
get stuck in an infinite timeout loop, requiring a restart. This is now
handled automatically.
