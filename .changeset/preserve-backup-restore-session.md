---
'@cloudflare/sandbox': patch
---

Report failed parallel backup downloads as recoverable restore errors without terminating the backup session shell, so cleanup can complete and callers can retry restore.
