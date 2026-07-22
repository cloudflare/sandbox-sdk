---
'@cloudflare/sandbox': patch
---

Keep preview URLs working across container restarts. Previously, `exposePort()`
succeeded but preview requests returned `410 STALE_PREVIEW_URL` after any
container restart (including `exec` calls that woke a stopped container),
because the runtime-scoped activation was cleared on stop and only re-created by
a manual `exposePort()` call. Exposed ports are now automatically reactivated
for the new runtime when the container starts, so a preview URL keeps forwarding
without re-exposing. Ports that were unexposed or destroyed are not resurrected.
