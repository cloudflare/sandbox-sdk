---
'@cloudflare/sandbox': patch
---

Forward WebSocket upgrades on preview URLs with `Host: localhost:<port>`, like every other preview request. Dev servers that check the `Host` header, such as Vite, no longer reject HMR connections. The public hostname is still in `X-Forwarded-Host`.
