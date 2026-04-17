---
'@cloudflare/sandbox': patch
---

Preserve port tokens across container restarts so preview URLs remain valid
when a container stops or loses connectivity temporarily. Tokens are now only
removed on explicit `unexposePort()` calls or full sandbox `destroy()`.
Previously, `onStop()` deleted all port tokens from storage, invalidating every
preview URL on any restart — including transient ones. If a port isn't
actually exposed on the container after restart, token validation still fails
via the existing `isPortExposed()` check, so security is unchanged.
