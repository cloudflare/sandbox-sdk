---
'@cloudflare/sandbox': patch
---

Add an opt-in `enableDefaultSession: false` sandbox option for callers that want implicit operations to run in isolated per-operation sessions. Existing behavior remains the default; create an explicit session with `sandbox.createSession()` when you want state to persist across calls.
