---
'@cloudflare/sandbox': patch
---

Fix crash when a session is destroyed while a streaming command is in flight. Previously this caused `TypeError: null is not an object` from a null `shellExitedPromise`. Now returns a typed `SessionDestroyedError` (HTTP 410) instead.
