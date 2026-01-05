---
'@cloudflare/sandbox': patch
---

Fix sleepAfter option passed to getSandbox() being ignored.

The custom sleepAfter timeout value is now correctly applied when specified in getSandbox() options.
