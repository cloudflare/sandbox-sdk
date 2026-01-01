---
'@cloudflare/sandbox': patch
---

Fix sleepAfter option passed to getSandbox() being ignored due to timing.

The Container constructor calls renewActivityTimeout() with the default 10m before
the RPC call to setSleepAfter() runs. Now setSleepAfter() reschedules the activity
timeout with the new value.
