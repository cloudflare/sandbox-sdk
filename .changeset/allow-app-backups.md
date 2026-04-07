---
'@cloudflare/sandbox': patch
---

Allow `createBackup()` and `restoreBackup()` to target directories under `/app`.
`restoreBackup()` can now use just the backup ID and defaults to the original directory from backup metadata, while still allowing an explicit `dir` override when needed.
