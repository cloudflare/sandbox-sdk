---
'@cloudflare/sandbox': minor
---

Bind Sandbox operations to the specific container that started them. When a container is replaced (after sleep, eviction, or a crash), previously returned process and terminal handles and other in-flight work now fail fast with a clear error instead of silently resuming against a fresh container and repeating side effects. Re-fetch the handle (for example with `getProcess()`) after a restart to continue. Extension authors must run runtime work inside the scoped `withRuntime()` and `withSidecar()` callbacks rather than holding on to runtime clients or sidecar remotes.
