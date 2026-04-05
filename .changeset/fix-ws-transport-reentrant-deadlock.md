---
'@cloudflare/sandbox': patch
---

Fix deadlock in WebSocket transport when the container requires a cold start.

When a `Sandbox` subclass performs I/O inside its `onStart()` lifecycle hook
(e.g., calling `exec()`), the shared `connectPromise` in `WebSocketTransport`
created a circular await that blocked `blockConcurrencyWhile` until the
Cloudflare runtime reset the Durable Object (~30 s). Every subsequent attempt
hit the same cycle, leaving the workspace stuck in an infinite failure loop.

Requests that arrive while a WebSocket connection is being established
(`state === 'connecting'`) now fall back to a direct HTTP request via
`stub.containerFetch()`, breaking the cycle without affecting normal operation.
