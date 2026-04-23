---
'@cloudflare/sandbox': patch
---

Avoid duplicate session-create calls when parallel operations hit a
fresh sandbox. Parallel callers now share one setup call instead of
each issuing their own. Sequential operations are unaffected.

Session setup also now retries on the next operation if initialization
fails partway through, instead of silently treating the session as
ready.
