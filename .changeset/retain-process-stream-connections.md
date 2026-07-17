---
'@cloudflare/sandbox': patch
---

Fix streamed process output being cut short or never finishing for long-running or quiet commands. Reading a process with `logs()`, `output()`, `waitForExit()`, or `waitForPort()` now reliably delivers every line and resolves when the process exits, instead of occasionally ending early and dropping the final output.
