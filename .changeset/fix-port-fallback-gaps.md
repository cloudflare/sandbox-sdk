---
'@cloudflare/sandbox': patch
---

Improve container startup resilience for WebSocket transport. The SDK now ensures the container is ready before attempting WebSocket upgrades, matching the existing behavior for HTTP transport.
