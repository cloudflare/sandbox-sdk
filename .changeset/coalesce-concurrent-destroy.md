---
'@cloudflare/sandbox': patch
---

Coalesce concurrent `Sandbox.destroy()` calls onto a single teardown. If a
previous `destroy()` is still in flight, subsequent calls await the same
underlying work instead of starting a second teardown, and emit a canonical
`sandbox.destroy.coalesced` event per coalesced call for observability.
Once the in-flight teardown settles, later `destroy()` calls run a fresh
teardown as before. Fixes observed destroy-recreate thrash where external
health checks can invoke `destroy()` faster than the sandbox can initialize.
