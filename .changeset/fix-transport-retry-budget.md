---
'@cloudflare/sandbox': patch
---

Fix sandbox creation timing out for large container images even when startup timeouts are configured to allow enough time. The transport retry budget now automatically scales to match configured startup timeouts instead of being hard-coded at 120 seconds.
