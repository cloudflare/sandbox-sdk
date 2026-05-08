---
'@cloudflare/sandbox': patch
---

Add an opt-in `defaultSession: false` mode for top-level `sandbox.exec()` so one-shot scripts can run without mutating or terminating the default persistent session shell. Existing `sandbox.exec()` and `session.exec()` calls continue to preserve shell state by default.
