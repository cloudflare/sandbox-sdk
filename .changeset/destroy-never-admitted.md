---
'@cloudflare/sandbox': patch
---

Make `destroy()` succeed when the sandbox container was never admitted, so cleanup no longer fails with a no-instance platform error.
