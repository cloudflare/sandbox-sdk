---
'@cloudflare/sandbox': patch
---

Surface container allocation failures as `ContainerUnavailableError` instead of masking them as generic `utils.createSession` interruptions. When the Containers platform cannot admit a container during startup ("There is no container instance that can be provided to this Durable Object", the plain-text 503 "There is no Container instance available at this time", or "Maximum number of running container instances exceeded"), callers now receive the real, retryable cause with structured context. Detection is case-insensitive and realm-safe, and captured connection errors are preferred by structure (any `CONTAINER_UNAVAILABLE`-coded value) rather than only same-realm `SandboxError` instances, so the failure is no longer masked as an interrupted operation. Callers can distinguish the causes via `error.reason` (`'no_container_instance_available'` vs `'max_container_instances_exceeded'`), typed by the new exported `ContainerUnavailableReason`.
