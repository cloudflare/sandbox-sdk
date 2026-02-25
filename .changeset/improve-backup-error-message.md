---
'@cloudflare/sandbox': patch
---

Improve error message when backup upload verification fails due to a local/remote R2 mismatch. When using `wrangler dev`, presigned URLs upload to real R2 while the `BACKUP_BUCKET` binding defaults to local storage. The error now suggests adding `"remote": true` to the R2 binding in `wrangler.jsonc`.
