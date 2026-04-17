---
'@cloudflare/sandbox': patch
---

Automatically re-expose ports on the container runtime after a container
restart. Port tokens persisted in Durable Object storage are used to restore
port exposure transparently, so preview URLs keep working across transient
container restarts without any customer action. Ports that are already
exposed are skipped, and individual failures are logged but do not block
restoring the other ports.
