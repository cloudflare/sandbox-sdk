---
'@cloudflare/sandbox': patch
---

Add `sessionId: false` for top-level one-shot `sandbox.exec()` scripts that may call `exit`, `exec`, or `set -e` without terminating or mutating the default persistent session shell. Existing `sandbox.exec()` and `session.exec()` calls continue to preserve shell state by default.
