---
'@cloudflare/sandbox': patch
---

Add `getRuntimeIdentity()` to read a placement-derived `runtimeId`
for the currently observed sandbox runtime. The value stays stable
while the same container keeps running and refreshes after
SDK-observed restarts.
