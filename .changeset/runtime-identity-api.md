---
'@cloudflare/sandbox': patch
---

Add `getRuntimeIdentity()` to read a placement-derived `runtimeId`
for the currently observed sandbox runtime. The value stays stable
while the same container keeps running, refreshes after SDK-observed
restarts, and falls back to older container images that do not yet
expose the dedicated runtime identity endpoint.
