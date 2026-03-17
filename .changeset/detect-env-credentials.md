---
'@cloudflare/sandbox': patch
---

Add automatic detection of S3 credentials when mounting buckets. Now we do not need to explicitly declare credentials when mounting buckets if they are set as environment variables in the Durable Object.
