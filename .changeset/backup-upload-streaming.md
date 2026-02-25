---
'@cloudflare/sandbox': patch
---

Stream backup archive uploads to presigned R2 URLs with `curl -T` instead of `--data-binary`.
This avoids large in-memory payload allocation and improves reliability for multi-GB backups.
