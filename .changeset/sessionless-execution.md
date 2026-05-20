---
'@cloudflare/sandbox': patch
---

Add sessionless execution mode with a configurable default-session policy.

Set `enableDefaultSession: false` in `SandboxOptions` to run implicit top-level operations without a persistent shell — each command gets a fresh process with no shared state. Explicit per-call session IDs remain supported only when default sessions are enabled.
