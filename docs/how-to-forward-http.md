# How to forward HTTP

This guide forwards HTTP or WebSocket traffic to a process listening in a
sandbox.

`@cloudflare/sandbox` does not wrap ports, authentication, or public URLs. Use
native `container.getTcpPort(port).fetch(request)`.

Start the container, then wait until the guest is actually listening.
`container.start()` does not imply readiness.

Rewrite the container-hop URL to `http:` and forward the request:

```ts
const url = new URL(request.url);
url.protocol = "http:";
return this.ctx.container.getTcpPort(8080).fetch(new Request(url, request));
```

Passing an external `https:` URL through unchanged is rejected. Strip bearer
credentials at the Worker boundary before forwarding; native fetch preserves
headers and cookies.

If nothing is listening, `fetch` rejects; wait for the guest instead of
treating start as readiness. If incremental delivery matters, test the
deployed route, not only the native hop. If the guest sets more than one
`Set-Cookie`, read them with `getSetCookie()`.

If the client aborts, do not retry a non-idempotent request. Cancellation
leaves partial effects.

For why the hop is already secure, see [About sandboxes](about-sandboxes.md).
For a runnable Worker, see [Service forwarding](../examples/service-forwarding).
