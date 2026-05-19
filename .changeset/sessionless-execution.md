---
'@cloudflare/sandbox': patch
---

Add sessionless execution mode with a configurable default-session policy.

Set `enableDefaultSession: false` in `SandboxOptions` (or call `sandbox.setEnableDefaultSession(false)`) to run implicit operations without a persistent shell — each command gets a fresh process with no shared state. Use the new `SESSIONLESS_SESSION_ID` (`'none'`) constant as `sessionId` on individual calls to opt a single operation into sessionless mode without changing the sandbox-level policy.
