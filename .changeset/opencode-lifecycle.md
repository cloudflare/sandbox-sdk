---
'@cloudflare/sandbox': minor
---

Rework `@cloudflare/sandbox/opencode` around a durable lifecycle handle. Attach `withOpenCode(this, { directory, config, storage: this.ctx.storage })` as a field on your `Sandbox` subclass to own the `opencode serve` process. The handle is a `SandboxExtension`, so it is reachable as `sandbox.opencode.<method>()` from a Worker (`start`/`stop`/`status`/`fetch`). The server starts lazily; call `opencode.start()` from your subclass's `onStart` to start it optimistically. When `storage` is passed, the server config is recovered from persisted desired-state after a Durable Object eviction (cold start).

Build a typed SDK client from either the Worker stub or inside the DO with `createOpenCodeClient(sandbox.opencode)`, and wrap a Worker entrypoint with the curried `createOpenCodeProxy(env => getSandbox(...).opencode)(handler)` to serve the OpenCode web UI for any request your handler 404s.

This is a breaking change: the `createOpencode`, `createOpencodeServer`, `proxyToOpencode`, and `proxyToOpencodeServer` free functions are no longer exported. Replace `createOpencode(sandbox, opts)` with `withOpenCode(this, opts)` plus `createOpenCodeClient(sandbox.opencode)`, and replace the proxy helpers with `createOpenCodeProxy`.
