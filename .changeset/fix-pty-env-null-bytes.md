---
'@cloudflare/sandbox': patch
---

Fix environment variables not being inherited by PTY sessions opened via `sandbox.terminal`. Variables set with `setEnvVars()` were silently lost during env capture due to null-byte delimiter stripping in the exec pipeline.
