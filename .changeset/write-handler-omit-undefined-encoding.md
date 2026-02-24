---
'@cloudflare/sandbox': patch
---

Fix file writes without an explicit `encoding` so requests use default write options instead of sending `encoding: undefined`.
