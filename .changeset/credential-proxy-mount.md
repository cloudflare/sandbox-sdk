---
'@cloudflare/sandbox': patch
---

Add `credentialProxy` option to `mountBucket` to keep real S3 credentials out of the container. When enabled, the Durable Object intercepts and signs outbound S3 requests — the container only sees dummy credentials. Supports S3-compatible endpoints, R2, and GCS HMAC signing.
