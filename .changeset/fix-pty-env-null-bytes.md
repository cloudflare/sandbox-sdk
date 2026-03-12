---
'@cloudflare/sandbox': patch
---

Fix environment variables not being inherited by PTY sessions opened via `sandbox.terminal`. Variables set with `setEnvVars()` were not being passed to the terminal environment.
