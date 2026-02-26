---
'@cloudflare/sandbox': patch
---

Improve `readFile()` and `readFileStream()` performance by using native syscall file reads instead of shell-based reads.
This increases read transfer speeds and unblocks the max throughput from file streaming.

Improving file size handling: calls to `readFile()` now return a `413: File too large error` if the target file exceeds `32 MiB`. Previously such files would trigger a generic error; we're now explicit about the limitation and recommend using `readFileStream` for larger files.
