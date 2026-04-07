---
'@cloudflare/sandbox': patch
---

Allow `createBackup()` and `restoreBackup()` to target directories under `/app`.
This makes backups work with custom images that keep application files in `/app` instead of `/workspace`.
