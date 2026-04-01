---
'@cloudflare/sandbox': patch
---

Fix slow parallel code context creation. Creating multiple contexts concurrently (e.g. 10 at once) no longer scales linearly with each request — wall time drops from ~5s to ~500ms.
