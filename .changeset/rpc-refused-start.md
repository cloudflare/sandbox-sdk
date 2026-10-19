---
'@cloudflare/sandbox': patch
---

Stop the first call on the RPC transport from failing when Cloudflare can't provide a container right away. The call now keeps waiting for the container within its retry window.
