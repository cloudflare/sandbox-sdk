---
'@cloudflare/sandbox': patch
---

Let the warm pool know its instance ceiling up front via the
`WARM_POOL_MAX_INSTANCES` bridge variable. Set it to match your container's
`max_instances` so the pool makes correct capacity decisions without first
crashing into the limit. `0` (the default) preserves the existing auto-learn
behaviour.
