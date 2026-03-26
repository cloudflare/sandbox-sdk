---
'@cloudflare/sandbox': minor
---

Add outbound HTTP interception for sandboxes. Define `outbound` or `outboundByHost` handlers on your Sandbox class to intercept, modify, or block HTTP requests made from within the sandbox -- with full access to Workers bindings like KV and R2. `ContainerProxy` is now exported directly from `@cloudflare/sandbox`. Requires `@cloudflare/containers` 0.2.0+.
