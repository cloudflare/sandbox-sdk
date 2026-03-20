---
'@cloudflare/sandbox': patch
---

Add a Chromium-capable sandbox image variant for production deployments and local test-worker builds.

As a base image:

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.18-chromium
```

Or copy the binary into your own Alpine image:

```dockerfile
COPY --from=docker.io/cloudflare/sandbox:0.7.18-chromium /container-server/sandbox /sandbox
```
