---
'@cloudflare/sandbox': patch
---

Fix four root causes of intermittent sandbox failures: a debounce deadlock in log pattern matching that caused startups to time out, incorrect HTTP 500 classification for transient startup errors that prevented retries, a WebSocket chunk race where streaming responses dropped data before the controller was ready, and missing timeout protection on git clone operations that could hang indefinitely on slow or unreachable remotes.
