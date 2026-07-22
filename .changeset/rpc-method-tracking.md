---
'@cloudflare/sandbox': patch
---

Keep RPC sessions alive while method calls are pending to avoid intermittent `RPC session was shut down by disposing the main stub` failures during concurrent sandbox startup.
