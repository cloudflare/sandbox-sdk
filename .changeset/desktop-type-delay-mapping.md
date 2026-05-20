---
'@cloudflare/sandbox': patch
---

Fix `desktop.type()` `delayMs` option being silently dropped over the RPC transport. The option is now correctly forwarded for both HTTP and RPC clients, with the user-facing `{ delayMs }` shape consistent across both.
