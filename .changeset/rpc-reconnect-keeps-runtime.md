---
'@cloudflare/sandbox': patch
---

Keep preview URLs and tunnels working on the RPC transport after the control connection reconnects. The connection closes after 1 second without calls, and the next call used to rerun the sandbox's start handling even though the container was still running. Preview URLs then returned `410 STALE_PREVIEW_URL`, `getExposedPorts()` returned an empty list, quick tunnels disappeared from `tunnels.list()`, and `tunnels.get()` could fail with "Tunnel recovery attempts were exhausted".
