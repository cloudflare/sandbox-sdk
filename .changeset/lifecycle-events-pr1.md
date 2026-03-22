---
'@cloudflare/sandbox': patch
---

Add lifecycle event recording with `sandbox.listEvents()` for sandbox starts,
process exits, and port exposure changes. This makes it easier to build
orchestration flows that replay state changes without constant polling.
