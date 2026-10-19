---
'@cloudflare/sandbox': patch
---

Keep R2 binding mounts, credential-proxy mounts, and git authentication working when the Sandbox Durable Object restarts while its container keeps running. Mounts used to stay listed but fail every read and write with `EIO` until `mountBucket()` was called again.
