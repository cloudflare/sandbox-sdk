---
'@cloudflare/sandbox': patch
---

Allow multipart backup uploads to trust the runtime HTTPS interception certificate, so backups larger than 10 MiB work when `interceptHttps` is enabled.
