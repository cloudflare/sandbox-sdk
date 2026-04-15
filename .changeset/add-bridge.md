---
'@cloudflare/sandbox': patch
---

Add the sandbox bridge — an HTTP API that translates REST calls into Sandbox Durable Object operations. Deploy the bridge as a standalone Cloudflare Worker to expose session management, command execution, file read/write, PTY, and workspace mount/unmount over HTTP. Includes an optional warm pool Durable Object for pre-provisioning sandboxes to reduce cold-start latency.

Import the bridge factory and warm pool from `@cloudflare/sandbox/bridge`.

```ts
import { bridge } from '@cloudflare/sandbox/bridge';
export { Sandbox } from '@cloudflare/sandbox';
export { WarmPool } from '@cloudflare/sandbox/bridge';

export default bridge({
  fetch(request, env, ctx) {
    // your code here
    return new Response('OK');
  },
});
```
