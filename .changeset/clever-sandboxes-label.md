---
'@cloudflare/sandbox': patch
---

Add `labels` to `SandboxOptions` so `getSandbox()` can attach Cloudflare Container labels for analytics and observability. Labels are applied on container start; updates while running apply on the next start.
