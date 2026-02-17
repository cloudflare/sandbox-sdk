---
'@cloudflare/sandbox': patch
---

Add backup and restore API for creating point-in-time snapshots of sandbox directories

- `createBackup(dir, options)` - Creates compressed squashfs archive and uploads to R2
- `restoreBackup(id, options)` - Downloads and extracts backup to restore files
- Supports TTL-based expiration (default: 1 hour, max: 24 hours)
- Chunked uploads/downloads for archives up to 500MB
