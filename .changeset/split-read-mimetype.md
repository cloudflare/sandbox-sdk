---
'@cloudflare/sandbox': patch
---

Patch `readFile` to strip MIME type parameters, e.g. `text/plain;charset=utf-8` -> `text/plain`
