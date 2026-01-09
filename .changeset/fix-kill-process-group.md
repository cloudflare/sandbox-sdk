---
'@cloudflare/sandbox': patch
---

Fix killProcess() not terminating child processes spawned by background commands.

Previously, killing a background process would only terminate the wrapper subshell while child processes continued running as orphans. Now background commands run in their own process group, allowing killProcess() to terminate the entire process tree.
