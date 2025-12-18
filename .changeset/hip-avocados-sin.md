---
'@cloudflare/sandbox': patch
---

Replace HTTP polling with SSE streaming for waitForPort.
This reduces container log noise and eliminates repeated HTTP requests during port readiness checks.
