---
'@cloudflare/sandbox': patch
---

`tunnels.get()` now reports tunnel failures, such as `cloudflared` failing to start or missing from the image, with their own error codes instead of as RPC transport errors. A port no longer stays stuck when `cloudflared` is left running without a stored tunnel: the next `get()` stops it and starts a new tunnel, which needs the matching container image.
