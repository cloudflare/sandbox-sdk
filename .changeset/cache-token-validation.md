---
'@cloudflare/sandbox': patch
---

Cache successful preview URL token validations at the Worker level to avoid
calling the Sandbox Durable Object on every preview request. Page loads that
previously triggered 20+ RPCs to the DO for the same port and token now
trigger one, with the rest served from a per-isolate, TTL-bounded cache.
Failed validations are never cached, so transient "port not exposed" states
recover immediately once the port is re-exposed. A `clearTokenValidationCache`
helper is exported for callers that need to force re-validation.
