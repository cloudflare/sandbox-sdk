---
'@cloudflare/sandbox': patch
---

Surface s3fs mount failures from `mountBucket()`. Mount errors (bad credentials, wrong bucket name, network failures) now throw `S3FSMountError` with the underlying `s3fs` log output, instead of silently returning success and leaving no filesystem attached.

```ts
import { S3FSMountError } from '@cloudflare/sandbox';

try {
  await sandbox.mountBucket('my-bucket', '/mnt/data', {
    endpoint,
    credentials
  });
} catch (err) {
  if (err instanceof S3FSMountError) {
    // err.message includes the s3fs log tail, e.g. "403 AccessDenied"
  }
}
```
