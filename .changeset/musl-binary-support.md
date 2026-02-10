---
'@cloudflare/sandbox': patch
---

Publish a musl-compatible standalone binary (`sandbox-musl`) in the Docker image alongside the existing glibc binary. This lets you use Alpine and other musl-based Docker images with the standalone binary pattern — no glibc compatibility layer needed.

Copy from any `cloudflare/sandbox` image:

```dockerfile
COPY --from=docker.io/cloudflare/sandbox:VERSION /container-server/sandbox-musl /sandbox
```
