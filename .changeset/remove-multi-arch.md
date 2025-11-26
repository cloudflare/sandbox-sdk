---
'@cloudflare/sandbox': patch
---

Publish Docker images for linux/amd64 only to ensure dev/prod parity. ARM Mac users will automatically use emulation, matching production deployment behavior. This prevents architecture-specific bugs caused by Docker automatically selecting ARM64 variants on ARM hosts.
