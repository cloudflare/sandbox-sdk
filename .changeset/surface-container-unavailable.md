---
'@cloudflare/sandbox': patch
---

Surface container capacity failures as retryable `ContainerUnavailableError` (with a `reason`) instead of masking them as `utils.createSession` interruptions or raw transport errors, and make `destroy()` an idempotent no-op when the container was never admitted.
