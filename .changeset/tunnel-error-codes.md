---
'@cloudflare/sandbox': patch
---

`tunnels.get()` on the RPC transport now reports the real tunnel error, such as `cloudflared` failing to start or missing from the image, instead of "Tunnel recovery attempts were exhausted". It also no longer leaves a port stuck after giving up: a `cloudflared` left running from an earlier attempt is stopped and replaced. Replacing it needs the matching container image.
