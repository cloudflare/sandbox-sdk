---
'@cloudflare/sandbox': patch
---

Process termination now walks the command's process tree so killing a process also terminates child processes started by that command
