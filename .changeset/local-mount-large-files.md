---
'@cloudflare/sandbox': patch
---

Fix local bucket mounts for large files and write bursts. On the RPC transport, objects over 4 MiB now stream into the container instead of failing with an interrupted runtime connection. Container files stream back to R2 byte for byte, without loading the whole file into Worker memory. A file being written uploads once its changes settle, instead of on every write.
