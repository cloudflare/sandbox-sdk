---
'@cloudflare/sandbox': patch
---

Fix `killProcess()` so stopping a background command also terminates child
processes instead of leaving orphaned work running in the sandbox.
