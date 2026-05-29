---
'@cloudflare/sandbox': patch
---

Allow backup and restore presigned URLs to target non-default R2 endpoints. Set `BACKUP_BUCKET_ENDPOINT`, for example `https://<account_id>.eu.r2.cloudflarestorage.com`, when your backup bucket uses an R2 jurisdiction.
