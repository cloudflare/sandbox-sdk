---
'@cloudflare/sandbox': patch
---

Fix flaky OpenCode E2E test by checking health endpoint readiness

Changed `waitForPort` to verify `/global/health` returns HTTP 200 instead of just checking if the server accepts connections at `/`. This ensures the OpenCode server is fully initialized before `createOpencodeServer` returns, preventing 500 errors when tests immediately call the health endpoint.
