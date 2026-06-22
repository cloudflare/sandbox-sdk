---
'@cloudflare/sandbox': patch
---

Improve tunnel reliability across sandbox runtime restarts. `tunnels.get()` now recreates interrupted quick tunnels and respawns named tunnels when possible, while `tunnels.list()` only returns tunnel URLs backed by a currently running tunnel process.
