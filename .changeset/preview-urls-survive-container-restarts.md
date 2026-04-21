---
'@cloudflare/sandbox': patch
---

Fix preview URLs returning 404 after a container restart. Tokens and names
passed to `exposePort()` now persist across restarts, so URLs issued by
`exposePort()` keep working without re-exposing the port. Tokens are still
cleared when you call `unexposePort()` or `destroy()`.
