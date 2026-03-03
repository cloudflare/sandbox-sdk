---
'@cloudflare/sandbox': patch
---

Restructure CI/CD pipelines for faster builds and better reliability. Docker images now build once per commit using `buildx bake` with registry caching. Quality gates (lint, typecheck, unit tests) run in parallel. Conditional execution skips unnecessary work for docs-only and SDK-only changes.
