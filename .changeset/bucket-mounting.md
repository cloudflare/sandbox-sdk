---
'@cloudflare/sandbox': patch
---

Add S3-compatible bucket mounting

Enable mounting S3-compatible buckets (R2, S3, GCS, MinIO, etc.) as local filesystem paths using s3fs-fuse. Supports automatic credential detection from environment variables and intelligent provider detection from endpoint URLs.
