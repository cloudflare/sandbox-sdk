---
'@cloudflare/sandbox': patch
---

Fix `createOpencodeServer()` and `createOpencode()` waiting for the full three-minute startup timeout when `OPENCODE_SERVER_PASSWORD` is set. OpenCode answers the readiness check with 401 when a password is set, and that response now counts as ready.
