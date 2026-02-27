---
'@cloudflare/sandbox': patch
---

Fix local development crash loops after Docker restarts or idle timeouts. The Sandbox now detects stale container state and automatically recovers.
