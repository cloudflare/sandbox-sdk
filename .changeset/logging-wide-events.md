---
'@cloudflare/sandbox': patch
---

Structured logging for Workers Observability and Containers Logs. All operations emit queryable fields (`event`, `outcome`, `durationMs`, `command`, `exitCode`, `sessionId`) that can be filtered and aggregated in the dashboard. Presigned R2 URL parameters and embedded git URL credentials are redacted from all log fields. Set `SANDBOX_LOG_FORMAT=pretty` for readable local dev output.
