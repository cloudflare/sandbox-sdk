---
"@cloudflare/sandbox": patch
---

Fix sandboxes staying awake indefinitely after disabling `keepAlive`. Calling `setKeepAlive(false)` now correctly re-arms the `sleepAfter` timeout so the sandbox returns to its configured sleep lifecycle.
