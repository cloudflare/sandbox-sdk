---
'@cloudflare/sandbox': patch
---

Remove unimplemented parameters from API: timeout for execStream() and startProcess(), encoding and autoCleanup for startProcess(). These parameters were defined in types but not used in execution.
