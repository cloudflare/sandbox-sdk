---
'@cloudflare/sandbox': patch
---

Speed up preview URL authorization and close a race in `unexposePort()`.
Preview URL auth checks no longer make an extra round-trip to the
container runtime, so pages that fetch many assets through a single
preview URL do less work per request. `unexposePort()` now revokes
the preview token before signaling the container, so a preview
request that races an `unexposePort()` call can no longer reach the
process running inside the sandbox after the token has been revoked.
`getExposedPorts()` also no longer throws when it encounters a port
left in an inconsistent state by a failed `unexposePort()`; such
ports are omitted from the result and logged as a warning.
