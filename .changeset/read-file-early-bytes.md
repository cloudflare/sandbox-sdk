---
"@cloudflare/sandbox": patch
---

pr: 1001

Fix `Files.readFile()` hanging forever when the container sends file bytes before the opening control frame. The read now completes however the container transport orders the two streams.
