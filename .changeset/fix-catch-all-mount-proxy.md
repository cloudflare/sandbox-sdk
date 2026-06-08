---
'@cloudflare/sandbox': patch
---

Fix bucket mounts when a Sandbox class defines a catch-all outbound handler by routing SDK-managed mount hosts through the SDK ContainerProxy.
