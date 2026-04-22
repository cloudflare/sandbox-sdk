---
'@cloudflare/sandbox': patch
---

Avoid duplicate session-create calls when parallel operations hit a
fresh sandbox. Parallel callers now share one setup call instead of
each issuing their own. Sequential operations are unaffected.

If the storage write that records the session id fails after the
container accepts the create call, setup now retries on the next
operation instead of being treated as complete.
