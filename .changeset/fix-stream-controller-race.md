---
'@cloudflare/sandbox': patch
---

Fix stream controller race condition causing "Invalid state: Controller is already closed" errors

Resolves an issue where client disconnections during streaming operations could cause unhandled TypeError exceptions, potentially corrupting the SDK bridge state. The fix adds defensive error handling in the execute streaming handler to gracefully handle callbacks firing after stream cancellation.
