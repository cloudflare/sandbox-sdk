---
'@cloudflare/sandbox': patch
---

Fix phantom `running` processes after a failed `startProcess` call. When the underlying session was unavailable or threw during startup, the process record was left in memory with status `running` and would appear in `listProcesses()` indefinitely. Failed startups are now correctly marked as terminal `error` records.
