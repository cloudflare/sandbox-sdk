---
'@cloudflare/sandbox': patch
---

Fix three reliability issues: OpenCode readiness probe returning healthy before the binary is ready, file watch race condition where stale watchers could linger after cancellation, and SSE stream handler registering output listeners after replaying buffered logs — causing intermittent `waitForLog` timeouts on HTTP transport.
