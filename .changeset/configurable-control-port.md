---
'@cloudflare/sandbox': patch
---

Change the container control plane port from 3000 to 8671, freeing port 3000 for user services like Express and Next.js.

The port is configurable via the `SANDBOX_CONTROL_PORT` environment variable:

```toml
[vars]
SANDBOX_CONTROL_PORT = "9500"
```
