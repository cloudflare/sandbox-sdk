---
'@cloudflare/sandbox': minor
---

Prevent stale preview URLs from waking or reaching sandbox runtimes. Invalid, revoked, or destroyed preview URLs return `404 INVALID_TOKEN`; authorized URLs that are not activated for the current runtime return `410 STALE_PREVIEW_URL` until the port is exposed again. Existing preview URLs that previously survived container restart now return `410 STALE_PREVIEW_URL` after a restart until the port is exposed again in the new runtime.

`getExposedPorts()` and `isPortExposed()` now report only ports that are currently preview-forwardable in the active runtime. `unexposePort()` is now idempotent: revoking a port that is not currently exposed succeeds without contacting the container. Preview URL state no longer uses the container-local exposed-port registry or proxy routes.
