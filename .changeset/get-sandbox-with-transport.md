---
'@cloudflare/sandbox': patch
---

Adds a new `transport: 'http' | 'websocket'` field to the `getSandbox()` options. This can be
used to dynamically select transport on a per-sandbox basis.

> [!NOTE]
> Changing transport on an already existing sandbox may result in dropped connections, it is
> recommended to keep the same transport for the lifetime of the sandbox instance.

```ts
const sandbox = getSandbox(env.Sandbox, 'my-sandbox', {
  transport: 'websocket'
});
```
