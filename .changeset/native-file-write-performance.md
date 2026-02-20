---
'@cloudflare/sandbox': patch
---

Improve `writeFile()` performance by using native container file writes instead of shell-based write pipelines.
This reduces write latency for both UTF-8 and base64 payloads while preserving existing encoding behavior.
