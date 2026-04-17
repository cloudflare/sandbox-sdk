---
'@cloudflare/sandbox': minor
---

Preview URLs now survive transient container restarts. Port tokens persist
across restarts, and the container re-exposes previously exposed ports
automatically when it comes back up, preserving any friendly names passed to
`exposePort()`. Restoration runs under `blockConcurrencyWhile` so preview URL
requests that arrive during the startup window queue behind it rather than
seeing a 404. Tokens are still cleared on explicit `unexposePort()` and on
full sandbox `destroy()`; `validatePortToken()`'s live-container check
remains the ultimate authorization gate.
