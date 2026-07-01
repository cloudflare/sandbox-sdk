---
'@cloudflare/sandbox': patch
---

Surface container capacity failures as retryable `ContainerUnavailableError` (with a `reason`) instead of masking them as `utils.createSession` interruptions or raw transport errors, make `destroy()` an idempotent no-op when the container was never admitted, and record the wrapped error `.cause` chain on RPC trace spans so the true startup failure (e.g. container not listening, network loss) is visible instead of the generic "no container instance" wrapper.
