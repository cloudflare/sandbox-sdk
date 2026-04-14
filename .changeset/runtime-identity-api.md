---
'@cloudflare/sandbox': patch
---

Add `getRuntimeIdentity()` to detect when a sandbox starts a new
container runtime. It returns a stable placement-based `runtimeId`
that stays available after the initial container startup, so callers
can compare the current runtime with the last one they observed.
