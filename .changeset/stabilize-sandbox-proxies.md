---
'@cloudflare/sandbox': patch
---

Keep filesystem watch and terminal output streams open across Worker to Durable Object calls. HTTPS preview and proxy requests now reach the container over HTTP as expected. Sandbox setup finishes before the first forwarded request runs, repeated restores reapply the chosen backup, and idle expiry stops the container cleanly.
