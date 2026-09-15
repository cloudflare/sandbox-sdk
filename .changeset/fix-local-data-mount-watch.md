---
'@cloudflare/sandbox': patch
---

Fix bidirectional local R2 synchronization for bucket mounts outside `/workspace`, including documented paths such as `/data`. Public `watch()` and `checkChanges()` calls now consistently resolve relative paths from `/workspace` and reject paths outside it on every transport.
