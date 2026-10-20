---
'@cloudflare/sandbox': patch
---

Keep streaming `exec()` alive while a command is quiet, and enforce its `timeout`. Quiet commands were cut off after about four minutes on the HTTP transport and five on WebSocket. The timeout was ignored on those transports, and on every transport for commands that run in a session. Requires the matching container image.
