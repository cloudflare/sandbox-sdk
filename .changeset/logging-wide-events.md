---
'@cloudflare/sandbox': patch
---

Adopt canonical log lines for improved observability. Each operation now produces a single structured log entry with timing, outcome, and context, replacing scattered start/end log pairs. Enable `SANDBOX_LOG_LEVEL=debug` to see all events.
