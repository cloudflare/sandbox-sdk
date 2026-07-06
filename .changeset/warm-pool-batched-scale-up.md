---
'@cloudflare/sandbox': patch
---

Fill the warm pool in bounded-parallel batches instead of one container at a
time, so it primes and recovers far faster after a burst. Tune the batch size
with `WARM_POOL_SCALE_BATCH_SIZE` (default 5, clamped to 20).
