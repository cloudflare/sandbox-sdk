---
'@cloudflare/sandbox': patch
---

Add process readiness detection with port and log pattern waiting
The `Process` object returned by `startProcess()` now includes readiness methods:

- `process.waitForPort(port, options?)`: Wait for process to listen on a port
  - Supports HTTP mode (default): checks endpoint returns expected status (200-399)
  - Supports TCP mode: checks port accepts connections
  - Configurable timeout, interval, path, and expected status

- `process.waitForLog(pattern, options?)`: Wait for pattern in process output
  - Supports string or RegExp patterns
  - Returns matching line and capture groups
