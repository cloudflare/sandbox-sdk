---
'@cloudflare/sandbox': minor
---

Add HTTP bridge and external client SDK for cross-platform Sandbox access

This release adds two new subpath exports to enable accessing the Sandbox SDK from any platform via HTTP:

**Bridge (`@cloudflare/sandbox/bridge`):**

- `createBridge()`: Factory function that creates a Worker handler exposing the Sandbox API over HTTP
- Supports Bearer token authentication via `SANDBOX_API_KEY` environment variable
- Handles CORS for browser-based clients
- Exposes all sandbox operations: exec, files, processes, git, code interpreter, and sessions

**Client SDK (`@cloudflare/sandbox/client`):**

- `getSandbox(id, options)`: Creates a client that connects to a bridge Worker
- `BridgeSandboxClient`: Full implementation of the `ISandbox` interface using HTTP transport
- Works from any environment with `fetch` support (Node.js, Python via HTTP, browsers, etc.)

**Example usage:**

```typescript
// Bridge Worker (deploy this to Cloudflare)
import { createBridge, Sandbox } from '@cloudflare/sandbox/bridge';
export { Sandbox };
export default createBridge();

// Client (run from anywhere)
import { getSandbox } from '@cloudflare/sandbox/client';

const sandbox = getSandbox('my-project', {
  baseUrl: 'https://your-bridge.workers.dev',
  apiKey: 'your-api-key'
});

const result = await sandbox.exec('echo "Hello from anywhere!"');
```
