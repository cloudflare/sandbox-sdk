---
'@cloudflare/sandbox': minor
---

Keep each sandbox operation on the container that started it. If that container is replaced after sleep, eviction, or a crash, in-flight work and old process or terminal handles fail instead of continuing against the new container. Create or look up handles again after the new container is running. Extension authors should run runtime work inside `withRuntime()` and `withSidecar()`.
