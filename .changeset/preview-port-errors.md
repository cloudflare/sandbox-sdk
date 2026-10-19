---
'@cloudflare/sandbox': patch
---

Answer a preview request with `502` when the app's port in the container fails, for example because nothing listens on it or it closes the connection, and log the original error. Previously the error escaped the Sandbox, `proxyToSandbox()` answered `500 Proxy routing error`, and the log blamed a platform runtime update.
