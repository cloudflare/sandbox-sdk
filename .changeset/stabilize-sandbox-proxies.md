---
'@cloudflare/sandbox': patch
---

Keep filesystem watch and terminal output subscriptions connected when they cross Worker RPC boundaries. Container HTTP and WebSocket proxies now also accept requests whose external URL uses HTTPS by forwarding them over the container runtime's supported HTTP transport. Configured sandbox clients wait for their settings to apply before forwarding the first operation.

Sandbox clients continue to expose the inherited `containerFetch()` overloads and honor `switchPort()` routing for HTTP and WebSocket requests while reserving internal control-plane routes.

Repeated explicit restores now reapply the selected backup instead of returning a stale committed result. Inactivity expiry also stops the container without re-entering the sandbox activity gate.
