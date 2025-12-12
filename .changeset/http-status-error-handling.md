---
'@cloudflare/sandbox': patch
---

Improve automatic retry behavior for container startup errors

Transient errors like "container starting" now automatically retry with exponential backoff, while permanent errors like "missing image" fail immediately with clear error messages.
