---
'@cloudflare/sandbox': patch
---

Add named-tunnel support to `sandbox.tunnels.get(port, { name })`. Named tunnels bind a user-controlled hostname (`<name>.<your-zone>`) backed by a Cloudflare Tunnel and a proxied CNAME on your zone, so the URL is stable across container restarts and across sandboxes that share the same name. Calling `sandbox.destroy()` tears down the Cloudflare tunnel and DNS record alongside the container.

```ts
const tunnel = await sandbox.tunnels.get(8080, { name: 'app' });
console.log(tunnel.url); // → https://app.example.com
```
