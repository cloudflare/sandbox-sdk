---
'@cloudflare/sandbox': patch
---

Refill the warm pool the moment it drains instead of waiting for the next
background tick. After a burst consumes warm containers, replenishment now
starts immediately, cutting the latency tail for sandboxes created during
sustained or back-to-back bursts.
