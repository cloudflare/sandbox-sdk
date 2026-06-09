---
'@cloudflare/sandbox': minor
---

Remove the legacy HTTP and WebSocket sandbox transports. The SDK now uses the RPC control channel exclusively, so transport selection options have been removed.
