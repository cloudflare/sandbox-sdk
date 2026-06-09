---
'@cloudflare/sandbox': patch
---

Recover automatically from transient infrastructure failures when the SDK opens its WebSocket control connection to a sandbox. Previously, any 5xx response other than 503 on the upgrade would fail the SDK call even when the container was healthy.
