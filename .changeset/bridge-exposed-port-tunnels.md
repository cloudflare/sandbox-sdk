---
'@cloudflare/sandbox': patch
---

Add a bridge endpoint for resolving public URLs for sandbox services. HTTP clients can call `POST /v1/sandbox/:id/exposed-port/:port` with an optional `name` body field to request a predictable named URL instead of an ephemeral one.
