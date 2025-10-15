# Production Deployment Guide

This guide explains how to deploy the Cloudflare Sandbox SDK to production with proper port exposure support.

## Why Custom Domains Are Required

**Port exposure requires wildcard DNS routing**, which is not available on the free `workers.dev` domain.

When you expose a port, the SDK generates preview URLs like `https://8080-sandbox-abc123.yourdomain.com`. This subdomain pattern cannot work on `workers.dev` because:
- Workers.dev only supports single-level subdomains: `worker-name.account.workers.dev`
- Custom subdomains like `8080-sandbox-token.worker.workers.dev` won't resolve

## Setup

### Prerequisites

1. A domain added to your Cloudflare account
2. Access to the Cloudflare dashboard

### Step 1: Add Domain to Cloudflare

If not already added:
1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. Click "Add a Site" and follow the nameserver setup

### Step 2: Create Wildcard DNS Record

In the Cloudflare dashboard:
1. Go to your domain → **DNS** → **Records**
2. Click **Add record**
3. Configure:
   - **Type**: `A`
   - **Name**: `*`
   - **IPv4 address**: `192.0.2.0`
   - **Proxy status**: **Proxied** (orange cloud)
4. Click **Save**

### Step 3: Configure Worker Routes

Update your `wrangler.jsonc`:

```jsonc
{
  "routes": [
    {
      "pattern": "*.yourdomain.com/*",
      "zone_name": "yourdomain.com"
    }
  ]
}
```

Replace `yourdomain.com` with your actual domain.

### Step 4: Deploy

```bash
npx wrangler deploy
```

Cloudflare will automatically configure the route and provision SSL certificates.

### Step 5: Test

```typescript
const preview = await sandbox.exposePort(8080);
console.log(preview.url);
// https://8080-sandbox-abc123xyz.yourdomain.com
```

## Troubleshooting

### Custom domain required error

If you get `CustomDomainRequiredError`:
1. Verify deployment URL doesn't end with `.workers.dev`
2. Confirm wildcard DNS record exists: `*.yourdomain.com` → `192.0.2.0` (Proxied)
3. Check wildcard route in `wrangler.jsonc`: `*.yourdomain.com/*`
4. Redeploy: `npx wrangler deploy`

### SSL/TLS handshake failed

- Wait a few minutes for SSL certificate provisioning
- Verify DNS record is **Proxied** (orange cloud)
- Check SSL/TLS mode is "Full" or "Full (strict)" in dashboard

### Preview URL not resolving

1. Confirm wildcard DNS exists and is **Proxied**
2. Verify route pattern matches in `wrangler.jsonc`
3. Wait 30 seconds for DNS propagation
4. Test: `dig 8080-test-token.yourdomain.com`

### Port not accessible

1. Ensure service listens on `0.0.0.0`, not `localhost`
2. Verify `proxyToSandbox()` is called first in your Worker's fetch handler
3. Check process is running: `sandbox.listProcesses()`

## Local Development

Local development uses `localhost` subdomain patterns which work without custom domain setup. See the [main README](../README.md#port-forwarding) for details.

## Getting Help

- Check the [troubleshooting section](#troubleshooting) above
- Review [examples](../examples/) in the repository
- Open an issue on [GitHub](https://github.com/cloudflare/sandbox-sdk/issues)
- [Cloudflare Workers Routing docs](https://developers.cloudflare.com/workers/configuration/routing/)
