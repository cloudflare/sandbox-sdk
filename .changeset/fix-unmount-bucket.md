---
'@cloudflare/sandbox': patch
---

Fix `unmountBucket()` silently succeeding when the FUSE filesystem fails to unmount. The method now checks the `fusermount` exit code and throws `BucketUnmountError` on failure, cleans up the mount directory after a successful unmount, and the container image includes the `/etc/mtab` symlink that `fusermount` requires.
