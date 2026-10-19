---
'@cloudflare/sandbox': patch
---

Speed up `mountBucket()` for R2 bindings. Each mount now writes its s3fs support files, updates the R2 route and creates the mount directory at the same time instead of one after another. Mounts still run one at a time, so the saving adds up when you mount several buckets.
