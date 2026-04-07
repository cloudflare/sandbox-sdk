---
'@cloudflare/sandbox': patch
---

Add `getRuntimeIdentity()` to detect when a sandbox starts a new
container runtime. Use the returned `runtimeId` to compare the current
runtime with the last one you observed and decide when reconciliation
is needed.
