---
'@cloudflare/sandbox': minor
---

Add support for custom tokens in `exposePort()` to enable stable preview URLs across deployments.

You can now pass a custom token when exposing ports to maintain consistent preview URLs between container restarts and deployments. This is useful for sharing URLs with users or maintaining stable references in production environments.

```typescript
// With custom token - URL stays the same across restarts
const { url } = await sandbox.exposePort(8080, {
  hostname: 'example.com',
  token: 'my-stable-token1' // Must be exactly 16 chars: a-z, 0-9, -, _
});
// url: https://8080-sandbox-id-my-stable-token1.example.com

// Without token - generates random token (existing behavior)
const { url } = await sandbox.exposePort(8080, {
  hostname: 'example.com'
});
// url: https://8080-sandbox-id-randomtoken12.example.com
```

Custom tokens must be exactly 16 characters and contain only lowercase letters, numbers, hyphens, and underscores to ensure URL compatibility.
