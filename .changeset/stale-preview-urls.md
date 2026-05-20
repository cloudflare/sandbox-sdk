---
'@cloudflare/sandbox': minor
---

Prevent stale preview URLs from waking or reaching sandbox runtimes. Invalid, revoked, or destroyed preview URLs return `404 INVALID_TOKEN`; authorized URLs that are not activated for the current runtime return `410 STALE_PREVIEW_URL` until the port is exposed again. Existing preview URLs that previously survived container restart now return `410 STALE_PREVIEW_URL` after a restart until the port is exposed again in the new runtime.
