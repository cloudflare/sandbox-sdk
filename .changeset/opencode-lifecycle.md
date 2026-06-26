---
'@cloudflare/sandbox': minor
---

Add a durable OpenCode lifecycle surface to `@cloudflare/sandbox/opencode`. Attach `withOpenCode(this)` as a field on an OpenCode-aware `Sandbox` subclass to own the `opencode serve` process (`ensure`/`stop`/`status`/`fetch`), which is re-ensured automatically after a container sleep or rollout. Build a typed SDK client from either the Worker stub or inside the DO with `createOpenCodeClient(sandbox.opencode)`, and wrap a Worker entrypoint with the curried `createOpenCodeProxy(env => getSandbox(...))(handler)` to handle the OpenCode web-UI route or forward to your handler. The existing `createOpencode`, `createOpencodeServer`, `proxyToOpencode`, and `proxyToOpencodeServer` helpers remain available.
