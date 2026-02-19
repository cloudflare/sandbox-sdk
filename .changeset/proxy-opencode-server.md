---
'@cloudflare/sandbox': patch
---

Add `proxyToOpencodeServer()` to proxy requests directly to a running OpenCode server without web UI redirect behavior. Use this helper for headless API and CLI traffic where raw request forwarding is preferred.
