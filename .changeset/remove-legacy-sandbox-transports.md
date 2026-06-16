---
'@cloudflare/sandbox': minor
---

The SDK now talks to the container over a single RPC control channel. The legacy HTTP and WebSocket transports have been removed along with their selection knobs — `SandboxTransport`, the `transport` option on `getSandbox()`, the `SANDBOX_TRANSPORT` env var, and `sandbox.setTransport()`. Remove any references to these from your Worker code and `wrangler.jsonc`; no replacement is needed.
