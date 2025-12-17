---
'@cloudflare/sandbox': minor
---

Add WebSocket transport to avoid sub-request limits in Workers and Durable Objects. Enable with `useWebSocket: true` in sandbox options to multiplex all SDK calls over a single persistent connection instead of individual HTTP requests.
