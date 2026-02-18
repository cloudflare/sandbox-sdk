---
'@cloudflare/sandbox': patch
---

Fix WebSocket transport killing long-running streams after 2 minutes.

The stream timeout is now an idle timer that resets on every chunk, so `execStream` and process log streams stay alive as long as data is flowing (default: 5 minutes of inactivity). Both the request timeout and stream idle timeout are now configurable via `transportTimeouts` in sandbox options or via `SANDBOX_REQUEST_TIMEOUT_MS` / `SANDBOX_STREAM_IDLE_TIMEOUT_MS` environment variables.
