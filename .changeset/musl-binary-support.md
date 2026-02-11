---
'@cloudflare/sandbox': minor
---

Add Alpine-based musl image variant published as `cloudflare/sandbox:VERSION-musl`.

A lightweight (51 MB) functional sandbox for Alpine and musl-based containers. Supports all core SDK methods (`exec`, file operations, git, port exposure, bucket mounting). Does not include Python or Node.js runtimes — add them with `apk add` to enable `runCode()`.

As a base image:

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.1-musl
```

Or copy the binary into your own Alpine image:

```dockerfile
COPY --from=docker.io/cloudflare/sandbox:0.7.1-musl /container-server/sandbox /sandbox
```
