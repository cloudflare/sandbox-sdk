---
'@cloudflare/sandbox': patch
---

Add sessionless execution mode with a configurable default-session policy.

Set `enableDefaultSession: false` in `SandboxOptions` to run implicit top-level operations without a persistent shell — each command gets a fresh process with no shared state. The option is scoped to the sandbox object returned by `getSandbox(...)`; explicit per-call session IDs continue to target that session.
