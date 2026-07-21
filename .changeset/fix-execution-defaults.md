---
'@cloudflare/sandbox': patch
---

Apply sandbox environment variables and the `/workspace` default directory to every process launch. Upgrade container lifecycle handling so stop events cannot race replacement startup, and complete warm pool teardown before releasing capacity.
