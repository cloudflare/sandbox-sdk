---
'@cloudflare/sandbox': patch
---

Fixed `createBackup` and `restoreBackup` with `localBucket: true` failing on the `rpc` transport for archives larger than ~24 MiB.
