---
'@cloudflare/sandbox': patch
---

Fix OpenCode readiness probe returning healthy before the binary is ready, and fix file watch race condition where stale watchers could linger after cancellation.
