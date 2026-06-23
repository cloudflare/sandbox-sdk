---
'@cloudflare/sandbox': patch
---

Classify sandbox runtime and platform update interruptions as structured errors instead of surfacing raw transport or Durable Object messages. This gives applications clear retry guidance for idempotent operations and reduces transient startup failures when a sandbox is starting up or being replaced during deployment rollouts.
