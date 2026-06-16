---
'@cloudflare/sandbox': patch
---

Improve backup restore resilience when the sandbox runtime is interrupted. The SDK now classifies interrupted restore attempts with structured lifecycle errors and retries recoverable backup restores internally.
