---
'@cloudflare/sandbox': patch
---

Surface container allocation failures as `ContainerUnavailableError` instead of masking them as generic `utils.createSession` interruptions. When the Containers platform cannot admit a container during startup ("There is no container instance that can be provided to this Durable Object" or "Maximum number of running container instances exceeded"), callers now receive the real, retryable cause with structured context.
