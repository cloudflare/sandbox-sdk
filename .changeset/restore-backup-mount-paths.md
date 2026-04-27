---
'@cloudflare/sandbox': patch
---

Fix production backup restores so live restored files remain available after `restoreBackup()` returns, and restore mount paths use the real backup ID instead of deriving one from the archive path.
