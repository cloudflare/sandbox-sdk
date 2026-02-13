---
'@cloudflare/sandbox': patch
---

Fix `fetch()` losing its `this` binding when called on the proxy returned by `getSandbox()`. This caused preview URL WebSocket routing to fail at runtime.
