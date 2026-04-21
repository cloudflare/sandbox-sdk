---
'@cloudflare/sandbox': patch
---

Speed up preview URL authorization by skipping a container round-trip.
The Durable Object now answers preview-URL auth checks from its own
storage instead of asking the container runtime. Pages that fetch many
assets through a single preview URL see less latency under load and use
less of the sandbox's per-request capacity.
