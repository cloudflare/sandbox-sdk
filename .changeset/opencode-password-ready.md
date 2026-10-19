---
'@cloudflare/sandbox': patch
---

Fix `createOpencodeServer()` and `createOpencode()` waiting for the full three-minute startup timeout when `OPENCODE_SERVER_PASSWORD` is set. When the password is passed in `env`, the client returned by `createOpencode()` now authenticates with it.
