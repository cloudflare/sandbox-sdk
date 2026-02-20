---
'@cloudflare/sandbox': patch
---

Improve process kill behavior for background jobs so terminating a process now
stops any child process tree, preventing orphaned subprocesses from continuing
after killProcess().
