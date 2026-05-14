---
'@cloudflare/sandbox': patch
---

Add `sandbox.tunnels` namespace with quick-tunnel support. Call `sandbox.tunnels.get(port)` to obtain a `https://<words>.trycloudflare.com` URL that proxies to `localhost:<port>` inside the sandbox. The call is idempotent: repeated calls for the same port return the same record from per-sandbox Durable Object storage. No Cloudflare account or DNS setup required.

```ts
const tunnel = await sandbox.tunnels.get(8080);
console.log(tunnel.url);
// → https://random-words-here.trycloudflare.com

const same = await sandbox.tunnels.get(8080);
console.log(same.url === tunnel.url); // true

await sandbox.tunnels.list();
await sandbox.tunnels.destroy(8080); // or destroy(tunnel)
```
