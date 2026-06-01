---
'@cloudflare/sandbox': patch
---

Add bridge endpoints for managing tunnels to sandbox services. HTTP clients can call `POST /v1/sandbox/:id/tunnel/:port` with an optional `name` body field for a predictable named URL, and `DELETE /v1/sandbox/:id/tunnel/:port` to remove the tunnel.
