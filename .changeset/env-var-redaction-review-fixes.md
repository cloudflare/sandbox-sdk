---
'@cloudflare/sandbox': patch
---

Auto-redact high-entropy env var values in `setEnvVars` logs. Pass `redact: true` to force-redact all values, or `false` to skip auto-detection.
