---
'@cloudflare/sandbox': patch
---

Apply sandbox environment variables and the default `/workspace` directory on every process launch again. Stopping a warm-pool sandbox now finishes container teardown before the slot is reused.
