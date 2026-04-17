---
'@cloudflare/sandbox': patch
---

Cache successful preview URL token validations at the Worker level so page
loads on preview URLs stop saturating the Sandbox Durable Object. Page loads
that previously made 20+ RPCs for the same port and token now make one per
cache window (10 s by default), with the rest served from a per-isolate,
TTL- and size-bounded cache. Failed validations are never cached, so
transient "port not exposed" states recover on the next request. Exports
`TokenValidationCache`, `proxyToSandbox` accepts an optional
`tokenValidationCache` so operators can tune TTL and size limits or share
one instance across handlers, and `clearTokenValidationCache()` is exposed
for tests and forced re-validation. This is a bridge toward signed (HMAC)
tokens that can be verified locally with zero RPCs; the cache unblocks
customers today without requiring a token-format change.
