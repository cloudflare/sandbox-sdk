---
'@cloudflare/sandbox': patch
---

Improve resilience when the sandbox runtime is interrupted. The SDK now surfaces structured lifecycle errors for platform/runtime interruptions and retries recoverable backup restores internally.
