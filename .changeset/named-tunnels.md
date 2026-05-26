---
'@cloudflare/sandbox': patch
---

Add named-tunnel support to `sandbox.tunnels.get(port, { name })`. Named tunnels bind a user-controlled hostname (`<name>.<your-zone>`) backed by a Cloudflare Tunnel and a proxied CNAME on your zone, so the URL is stable across container restarts and across sandboxes that share the same name. Calling `sandbox.destroy()` tears down the Cloudflare tunnel and DNS record alongside the container.

```ts
const tunnel = await sandbox.tunnels.get(8080, { name: 'app' });
console.log(tunnel.url); // → https://app.example.com
```

Requires `CLOUDFLARE_API_TOKEN` to be set as a Worker secret with `Account:Cloudflare Tunnel:Edit`, `Zone:DNS:Edit`, and — for account-owned (`cfat-`) tokens — `Account:Account Settings:Read`. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID` are inferred from the token when it is scoped to a single account/zone; set them explicitly to disambiguate. `CLOUDFLARE_TUNNEL_ACCOUNT_ID` overrides the account id for tunnel provisioning only.
