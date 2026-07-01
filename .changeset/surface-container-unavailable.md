---
'@cloudflare/sandbox': patch
---

Surface container allocation failures as `ContainerUnavailableError` instead of masking them as generic `utils.createSession` interruptions. When the Containers platform cannot admit a container during startup ("There is no container instance that can be provided to this Durable Object" or "Maximum number of running container instances exceeded"), callers now receive the real, retryable cause with structured context. Callers can distinguish the two via `error.reason` (`'no_container_instance_available'` vs `'max_container_instances_exceeded'`), typed by the new exported `ContainerUnavailableReason`.
