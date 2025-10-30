---
'@cloudflare/sandbox': patch
---

Add cache mounts to Dockerfile for faster builds

Adds cache mounts for npm, apt, and pip package managers in the Dockerfile. This speeds up Docker image builds when dependencies change, particularly beneficial for users building from source.
