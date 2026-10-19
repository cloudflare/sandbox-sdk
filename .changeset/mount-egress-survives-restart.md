---
'@cloudflare/sandbox': patch
---

Keep R2 binding and credential-proxy bucket mounts working when the Sandbox Durable Object restarts while its container keeps running. The mounts used to stay listed but fail every read and write with `EIO` until `mountBucket()` was called again.
