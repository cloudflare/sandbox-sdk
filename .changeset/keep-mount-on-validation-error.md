---
'@cloudflare/sandbox': patch
---

Fix `mountBucket()` breaking an existing mount when a second call for the same mount path fails with "already in use". The existing mount now stays mounted and usable.
