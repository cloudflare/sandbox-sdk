---
'@cloudflare/sandbox': patch
---

Improve tunnel reliability across sandbox runtime restarts. `tunnels.get()` now returns a fresh quick tunnel after a restart and respawns named tunnels at the same hostname when possible, while `tunnels.list()` hides stale tunnel URLs that are no longer usable. Quick tunnel startup now uses stable run IDs for retry-safe recovery, and named tunnels now reliably clean up the Cloudflare resources they create, even when setup is interrupted.
