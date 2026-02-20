---
'@cloudflare/sandbox': patch
---

Add backup and restore API for directory snapshots.

`createBackup()` archives a directory as a compressed squashfs image and uploads it to R2.
`restoreBackup()` downloads and mounts the archive with copy-on-write semantics via FUSE overlay.

Requires R2 presigned URL credentials: set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, and `BACKUP_BUCKET_NAME` as environment variables alongside the
`BACKUP_BUCKET` R2 binding. Archives transfer directly between the container and R2
at ~24 MB/s upload / ~93 MB/s download.
