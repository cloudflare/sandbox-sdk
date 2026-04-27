---
'@cloudflare/sandbox': patch
---

Fix production backup restores so restored files are materialized before `restoreBackup()` returns, and restore mount paths use the real backup ID instead of deriving one from the archive path.
