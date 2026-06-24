---
'@cloudflare/sandbox': patch
---

Disable the default session for bridge command and file requests. Calls without `Session-Id` now run without reusing shell state; pass `Session-Id` from the session API to preserve working directory or environment across calls.
