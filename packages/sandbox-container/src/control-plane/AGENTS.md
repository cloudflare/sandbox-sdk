# Control plane

This directory is the primary home for container-side control API methods used
by the Sandbox Durable Object.

Add control operations here. Use service methods directly rather than routing
through HTTP handlers. Keep `/rpc` as the external WebSocket route unless a task
explicitly changes the wire protocol.

The route handlers and `ws-adapter.ts` are compatibility paths for the
route-based API and do not receive control-plane capabilities by default.
