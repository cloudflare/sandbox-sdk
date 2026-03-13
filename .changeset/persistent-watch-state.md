---
'@cloudflare/sandbox': patch
---

Add persistent file watch state for hibernating Durable Object workflows.
Use `ensureWatch()`, `getWatchState()`, `checkpointWatch()`, and `stopWatch()` to keep a watch alive without holding an SSE stream open.
