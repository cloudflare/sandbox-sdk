---
'@cloudflare/sandbox': patch
---

Classify transient container unavailability as a retryable `CONTAINER_UNAVAILABLE` error instead of surfacing raw transport failures, and recover the default session when the container is replaced mid-initialization. This reduces spurious errors when a sandbox's container is starting up or being replaced during a deployment rollout.
