---
'@cloudflare/sandbox': patch
---

Add an experimental capnweb RPC endpoint to the bridge Worker. Opt in by setting `SANDBOX_EXPERIMENTAL_RPC=true` (which the bridge worker passes through as `enableExperimentalRPC: true`). The route is **not** stable — the API surface mirrors the still-evolving sandbox interface and is subject to breaking changes.

When enabled, bridge deployments expose `GET /v1/rpc`: a single WebSocket that gives clients a typed RPC handle to every sandbox method, no pool middleware, no per-sandbox URL. One connection addresses many sandboxes via `rpc.sandbox(id)` — sandbox-id validation lives inside the call, and a fresh ID is allocated when none is supplied.

Use the new `@cloudflare/sandbox/bridge-client` subpath for a typed TypeScript client:

```ts
import { createBridgeClient } from '@cloudflare/sandbox/bridge-client';

const client = createBridgeClient({
  baseURL: 'https://bridge.example.com/v1',
  token: process.env.SANDBOX_API_KEY
});

const sandbox = client.sandbox('my-sandbox');
const result = await sandbox.commands.execute('ls', sessionId);

await client.close();
```

The client opens one WebSocket per `BridgeClient` instance regardless of how many sandboxes you address, caches per-sandbox stubs, and surfaces auth failures as a typed `BridgeAuthError`. Authentication is carried in `Sec-WebSocket-Protocol: cloudflare-sandbox-bridge.bearer.<token>`, so the same client works in browsers, Bun, Node 22+, and Cloudflare Workers.

The RPC interface (`SandboxRPCAPI`) mirrors the container's internal `SandboxAPI` and exposes all ten domains: `commands`, `files`, `processes`, `ports`, `git`, `interpreter`, `utils`, `backup`, `desktop`, `watch`. Streaming methods (`commands.executeStream`, `processes.streamProcessLogs`, `interpreter.runCodeStream`) work end-to-end, including callback-style APIs.
