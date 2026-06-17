---
'@cloudflare/sandbox': minor
---

Remove the `enableDefaultSession` sandbox option. Top-level sandbox operations now run without hidden persistent session state by default; use `sandbox.createSession()` when you need commands or file operations to share explicit session state.
