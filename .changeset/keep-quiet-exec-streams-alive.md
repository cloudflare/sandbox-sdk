---
'@cloudflare/sandbox': patch
---

Keep streaming `exec()` alive while a command is quiet, and enforce its `timeout`, on the HTTP and WebSocket transports. Quiet commands were cut off after about four minutes on HTTP and five on WebSocket, and the timeout was ignored. Requires the matching container image.
