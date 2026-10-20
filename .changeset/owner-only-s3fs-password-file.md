---
'@cloudflare/sandbox': patch
---

Create the s3fs password file for `mountBucket()` with mode 0600 from the start. The file used to be readable by other users in the container until a chmod a moment later, long enough for a non-root process to open it and read the bucket credentials. Upgrade the container image together with the SDK to close the gap; with an older image, mounts work as before.
