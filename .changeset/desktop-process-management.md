---
'@cloudflare/sandbox': patch
---

Improve reliability of `desktop.stop()` as well as general isolation of the desktop processes by
running them in a subprocess. This should ensure that processes are cleaned up when calling
`desktop.stop()` and crashes should not impact the sandbox container service.
