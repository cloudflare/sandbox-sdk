---
'@cloudflare/sandbox': minor
---

Add WebSocket transport to avoid sub-request limits in Workers and Durable Objects. Set `SANDBOX_TRANSPORT=websocket` environment variable to multiplex all SDK calls over a single persistent connection.
