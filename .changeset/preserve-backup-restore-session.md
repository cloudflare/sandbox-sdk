---
'@cloudflare/sandbox': patch
---

Fix `restoreBackup()` error reporting for archives of 10 MB or more. A failed download part now throws a `BackupRestoreError` that includes curl's error output, instead of a `Shell terminated unexpectedly` session error.
