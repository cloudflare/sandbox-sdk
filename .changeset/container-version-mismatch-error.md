---
'@cloudflare/sandbox': patch
---

Fail early with `ContainerVersionMismatchError` when a deployed sandbox container is incompatible with the installed SDK. This gives developers an actionable deployment error so they can redeploy matching SDK and container versions instead of debugging obscure RPC failures.
