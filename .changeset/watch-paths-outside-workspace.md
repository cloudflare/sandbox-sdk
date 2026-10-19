---
'@cloudflare/sandbox': patch
---

Sync local bucket mounts outside `/workspace`, such as `/data`, from the container back to R2. `watch()` and `checkChanges()` now accept any absolute path on every transport, as documented. A local mount whose container rejects the watch now logs one error instead of retrying forever.
