---
"@cloudflare/sandbox": minor
---

Add `sandbox.tunnels` namespace with quick-tunnel support. Call `sandbox.tunnels.create(port)` to spawn a `cloudflared` quick tunnel inside the sandbox and get back a `https://<words>.trycloudflare.com` URL that proxies to `localhost:<port>` inside the container. No Cloudflare account or DNS setup required.

```ts
const tunnel = await sandbox.tunnels.create(8080);
console.log(tunnel.url);
// → https://random-words-here.trycloudflare.com

await sandbox.tunnels.list();
await sandbox.tunnels.destroy(tunnel);
```

Quick tunnels require the RPC transport and the glibc sandbox image variants (default, python, opencode, desktop) — the musl/Alpine variant does not include cloudflared.
