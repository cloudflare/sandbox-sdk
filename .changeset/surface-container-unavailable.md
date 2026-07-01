---
'@cloudflare/sandbox': patch
---

Surface container allocation failures as `ContainerUnavailableError` instead of masking them as generic `utils.createSession` interruptions. When the Containers platform cannot admit a container during startup ("There is no container instance that can be provided to this Durable Object" or "Maximum number of running container instances exceeded"), the SDK now retries within the startup budget and, if it remains unavailable, surfaces a typed `ContainerUnavailableError` carrying the real platform message and an actionable `reason`.

`Sandbox.containerFetch` now emits a structured `CONTAINER_UNAVAILABLE` 503 (preserving the original platform message) for these admission failures instead of a generic `INTERNAL_ERROR`, so the RPC control connection classifies them correctly. Detection is case-insensitive and realm-safe, and captured connection errors are preferred by structure (any `CONTAINER_UNAVAILABLE`-coded value) rather than only same-realm `SandboxError` instances. Callers can distinguish the causes via `error.reason` (`'no_container_instance_available'` vs `'max_container_instances_exceeded'`), typed by the new exported `ContainerUnavailableReason`.
