---
'@cloudflare/sandbox': patch
---

Fix Docker build failures caused by turbo prune lockfile mismatch

Remove @cloudflare/vite-plugin from root devDependencies to avoid turbo prune bug with nested optionalDependencies. The vite-plugin is only used by examples which are excluded from Docker builds and already have it in their own package.json.
