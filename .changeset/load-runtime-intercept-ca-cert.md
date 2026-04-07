---
'@cloudflare/sandbox': patch
---

Setting `interceptHttps = true` on your Sandbox will now automatically trust the Cloudflare-injected CA certificate at container startup, enabling outbound HTTPS traffic interception.
