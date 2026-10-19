---
'@cloudflare/sandbox': patch
---

Stop the container server from crashing with `ENOENT: no such file or directory, watch '…/<id>.log.stderr'` while commands run. The crash killed every process in the container. Update the container image to pick up this fix.
