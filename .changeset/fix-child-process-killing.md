---
'@cloudflare/sandbox': patch
---

Fix child processes surviving when parent is killed. Previously, processes spawned with `&` inside commands like `bash -c "sleep 100 &"` would escape termination. Now all descendant processes are properly killed.
