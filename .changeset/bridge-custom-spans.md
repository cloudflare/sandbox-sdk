---
'@cloudflare/sandbox': patch
---

Instrument the bridge API with Cloudflare custom spans. Each endpoint now emits
a `bridge.<operation>` span annotated with the sandbox ID, container UUID, and
operation-specific metadata (command, file path, port, session ID, and so on),
so requests are traceable end to end. Enable tracing with
`observability.traces.enabled` in your Worker configuration.
