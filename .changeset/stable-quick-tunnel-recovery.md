---
'@cloudflare/sandbox': patch
---

Recover quick tunnels when the sandbox runtime is replaced. `tunnels.get(port)` now provisions through an idempotent runtime-run boundary so a retry after a replacement returns a currently usable URL instead of a dead one, and `tunnels.list()` no longer returns quick tunnel URLs known to be stale after a container restart.
