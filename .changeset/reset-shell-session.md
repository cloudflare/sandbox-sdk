---
'@cloudflare/sandbox': patch
---

Add `preserveShellState: false` for one-shot `exec()` scripts that may call `exit`, `exec`, or `set -e` without terminating the persistent session shell. Existing `sandbox.exec()` and `session.exec()` calls continue to preserve shell state by default.
