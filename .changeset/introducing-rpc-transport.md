---
'@cloudflare/sandbox': patch
---

Introduce new `rpc` transport to consolidate `http` and `websocket` transports.

The intention is to replace `http` and `websocket` transports with a single implementation.

- No sub-request limitations (currently affects the `http` transport).
- No limit on write file size (currently affects both `http` and `websocket` transports).

To enable the transport set `SANDBOX_TRANSPORT` to `rpc` in your wrangler config.

A `ReadableStream` instance can now be passed to `sandbox.writeFile()` when using the `rpc` transport to avoid the 32mb file limit.

```js
{
  fetch(req, env) {
    const sandbox = getSandbox(env.Sandbox, "my-sandbox");

    // A ReadableStream can be passed as the content to writeFile().
    sandbox.writeFile("/workspace/archive.tar.gz", req.body);

    return new Response("OK");
  }
}
```
