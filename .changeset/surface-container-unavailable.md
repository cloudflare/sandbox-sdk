---
'@cloudflare/sandbox': patch
---

Surface container capacity and admission failures as retryable `ContainerUnavailableError` with a structured `reason`, including no-instance and max-instances cases. Callers can branch on `error.reason` instead of parsing platform messages.
