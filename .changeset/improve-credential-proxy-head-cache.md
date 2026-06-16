---
'@cloudflare/sandbox': patch
---

Improve credential-proxied bucket mounts by caching safe HEAD metadata lookups while preserving correctness for multipart writes, copy operations, and conditional or ranged requests.
