---
'@cloudflare/sandbox': patch
---

Fix supervisor-mode sandbox shutdown so inactivity `SIGTERM` cleanly exits the `/sandbox` process even when the user CMD has already exited or daemonized work in the background.
