---
'@cloudflare/sandbox': patch
---

Fix `mountBucket()` unmounting and forgetting an existing mount when a second call for the same mount path fails validation ("already in use"). Failed-mount cleanup now only runs for a mount path the failing call reserved itself.
