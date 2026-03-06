---
'@cloudflare/sandbox': patch
---

Prevent container shutdown during active operations. The base class `sleepAfter` alarm could fire and kill the container mid-operation (exec, writeFile, streaming, etc.), causing `ReadableStream disconnected prematurely` errors. An in-memory `activeOperations` counter now guards `onActivityExpired()`, deferring shutdown while any operation is in progress, with a 30-minute safety valve to prevent leaked counters from keeping containers alive forever.
