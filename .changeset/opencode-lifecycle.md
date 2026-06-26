---
'@cloudflare/sandbox': minor
---

Rework `@cloudflare/sandbox/opencode` around a durable lifecycle handle. Attach `withOpenCode(this)` as a field on the OpenCode-aware `Sandbox` subclass to own the `opencode serve` process (`ensure`/`stop`/`status`/`fetch`), which is re-ensured automatically after a container sleep or rollout. Build a typed SDK client from either the Worker stub or inside the DO with `createOpenCodeClient(sandbox.opencode)`, and wrap a Worker entrypoint with the curried `createOpenCodeProxy(env => getSandbox(...))(handler)` to handle the OpenCode web-UI route or forward to your handler.

This is a breaking change: the `createOpencode`, `createOpencodeServer`, `proxyToOpencode`, and `proxyToOpencodeServer` free functions are no longer exported. Replace `createOpencode(sandbox, opts)` with `withOpenCode(this, opts)` plus `createOpenCodeClient(sandbox.opencode)`, and replace the proxy helpers with `createOpenCodeProxy`.
