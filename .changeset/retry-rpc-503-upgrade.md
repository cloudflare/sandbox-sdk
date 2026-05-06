---
'@cloudflare/sandbox': patch
---

Ensure the RPC transport successfully connects once the container has started. This should
reduce the likelihood of hitting an `RPCTransportError: WebSocket upgrade failed: 503 Service
Unavailable` error when interacting with a sandbox before the container is ready.
