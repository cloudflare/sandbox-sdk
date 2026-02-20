---
'@cloudflare/sandbox': patch
---

Improve `readFile()` and `readFileStream()` performance by using native syscall file reads instead of shell-based reads.
This increases read transfer speeds and unblocks the max throughput from file streaming.
