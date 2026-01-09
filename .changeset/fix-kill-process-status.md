---
'@cloudflare/sandbox': patch
---

Fix processes getting stuck in 'running' status when killed after naturally exiting. Previously, if a process exited on its own but the kill request came before status updates were processed, the process would remain marked as 'running' indefinitely.
