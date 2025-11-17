---
'@cloudflare/sandbox': patch
---

Improve container startup resiliency

SDK now retries both 503 (provisioning) and 500 (startup failure) errors automatically. Container timeouts increased to 30s instance + 90s ports (was 8s + 20s).
