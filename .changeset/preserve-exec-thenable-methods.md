---
'@cloudflare/sandbox': patch
---

Fix `sandbox.exec(...).output()` / `.text()` / `.json()` / `.kill()` throwing `TypeError: ... is not a function`. The client-side wrapper that translates platform interruptions was replacing the returned thenable with a bare promise, which stripped the convenience methods the unified `exec()` surface attaches to its result.
