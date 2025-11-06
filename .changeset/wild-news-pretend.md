---
'@repo/sandbox-container': patch
'@cloudflare/sandbox': patch
'@repo/shared': patch
---

Expose deleteSession API with proper safeguards

- Add `deleteSession(sessionId)` method to public SDK API
- Prevent deletion of default session (throws error with guidance to use `sandbox.destroy()`)
- Session cleanup kills all running commands in parallel before destroying shell
- Return structured `SessionDeleteResult` with success status, sessionId, and timestamp
