---
'@cloudflare/sandbox': patch
---

Improve idle timeout handling for long-running streams over WebSocket transport.

Streams now remain open as long as data is flowing, timing out only after 5 minutes of inactivity.
