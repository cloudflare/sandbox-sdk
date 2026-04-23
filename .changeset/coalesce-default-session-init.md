---
'@cloudflare/sandbox': patch
---

Avoid duplicate session-create calls when parallel operations hit a
fresh sandbox. Parallel callers now share one setup call instead of
each issuing their own. Sequential operations are unaffected.

Session setup also now retries cleanly on the next operation if it is
interrupted partway through — including by a container stop during
first use — instead of leaving the sandbox in a state that looks
initialized but references a session the container no longer has.
