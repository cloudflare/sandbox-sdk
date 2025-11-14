---
'@cloudflare/sandbox': minor
---

Add opt-in `normalizeId` option to `getSandbox()` for preview URL compatibility.

Sandbox IDs with uppercase letters cause preview URL requests to route to different Durable Object instances (hostnames are case-insensitive). Use `{ normalizeId: true }` to lowercase IDs for preview URL support:

```typescript
getSandbox(ns, 'MyProject-123', { normalizeId: true }); // Creates DO with key "myproject-123"
```

**Important:** Different `normalizeId` values create different DO instances. If you have an existing sandbox with uppercase letters, create a new one with `normalizeId: true`.

**Deprecation warning:** IDs with uppercase letters will trigger a warning. In a future version, `normalizeId` will default to `true`.
