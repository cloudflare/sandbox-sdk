---
'@cloudflare/sandbox': patch
---

Fix `createBackup()` excludes that use gitignore-style `**` globstars.

Normalize globstar excludes to the mksquashfs-compatible patterns used by the backup pipeline so local and production backups handle them consistently.
