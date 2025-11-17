---
'@cloudflare/sandbox': patch
---

Expand SDK retry logic to handle container startup failures

SDK now automatically retries container startup failures (500 errors) in addition to provisioning delays (503 errors). Uses fail-safe error detection that only retries known transient container errors, preventing retry storms on user application errors. Increases retry budget from 60s to 120s to align with platform provisioning times. Production users benefit automatically without configuration changes.
