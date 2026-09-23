# Control outbound requests

Decide which hosts a sandbox can reach, add credentials to some of its requests, and change those rules while it runs. Done when a rule change applies to the next request from the Container, without restarting it.

The Container has no Internet access of its own. Every HTTP request on port 80 and HTTPS request on port 443 goes to an entrypoint in your Worker, and connections to other ports fail. The entrypoint reads the sandbox's current rules from its Durable Object, then blocks the request, fetches it, or passes it to a handler. The [outbound workspace example](../examples/outbound-workspace) is the complete Worker. For fixed rules only, see [Run a coding agent](run-a-coding-agent.md#2-keep-credentials-in-the-worker).

## 1. Keep the rules in the Durable Object

Store the rules in Durable Object storage. They outlast the Container, so a new Container follows the same rules. The example uses three lists of host patterns, checked in order: `deny`, then `handlers`, then `allow`. A host that matches none is blocked.

Done when `GET` and `PUT` on the rules return what you stored.

```ts
const OutboundRules = z.object({
  deny: z.array(HostPattern).default([]),
  handlers: z.record(HostPattern, z.enum(["bearer-token", "audit"])).default({}),
  allow: z.array(HostPattern).default([]),
});

outboundRules(): OutboundRules {
  return OutboundRules.parse(this.ctx.storage.kv.get("outbound-rules") ?? {});
}
```

In a pattern, `*` matches any run of characters, so `*.example.com` matches `api.example.com` but not `example.com`. `["*"]` in `allow` allows every host. Check an exact hostname in `handlers` before patterns. The example's `src/rules.ts` has the matching code.

## 2. Send every request to one entrypoint

Export a `WorkerEntrypoint` that reads the rules on each request. Pass the sandbox name in its props, so it can find the Durable Object.

Done when a request from the Container reaches the entrypoint and a blocked host gets `403`.

```ts
export class Outbound extends WorkerEntrypoint<Env, { sandboxName: string }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rules = await this.env.SANDBOX.getByName(this.ctx.props.sandboxName).outboundRules();
    const decision = decide(rules, url.hostname);
    if (decision.action === "deny") return new Response(`${decision.reason}\n`, { status: 403 });
    if (decision.action === "fetch") return fetch(request);
    return this.#handle(decision.handler, request);
  }
}
```

Reading the rules costs one call to the Durable Object for each request. In exchange, a change applies to the next request, and the Container's intercepts never change.

## 3. Intercept all traffic once per start

Start the Container with `enableInternet: false`. Then send all HTTP and all HTTPS to the entrypoint. Intercepts last until the Container stops, so install them after each `start()`.

Done when a new sandbox's `curl https://example.com/` prints `example.com is not allowed`.

```ts
this.#container.start({ image: this.#container.images.sandbox, enableInternet: false });
const outbound = this.ctx.exports.Outbound({ props: { sandboxName } });
await this.#container.interceptAllOutboundHttp(outbound);
await this.#container.interceptOutboundHttps("*", outbound);
```

Do not intercept each host separately to change the rules. An intercept cannot be removed, and each distinct hostname uses one of at most 64 routes in the Container.

Only HTTP on port 80 and HTTPS on port 443 reach the entrypoint. Connections to other ports time out. Keep `enableInternet: false`: with `true`, connections to other ports, including HTTP on port `8080`, go out directly and skip the rules. HTTPS to a bare IP address fails, because interception needs a hostname.

With `enableInternet: false`, DNS in the Container answers from the intercepts, not from a real resolver. While the intercept-all rule is installed, every name resolves to a placeholder address, `11.9.0.1` or `fd00::119:1`, even a name that does not exist. Only `A` and `AAAA` lookups get an answer. `TXT`, `MX`, and other lookups time out. Before the first intercept, every lookup times out.

## 4. Trust the interception certificate

HTTPS interception re-signs traffic with a Containers certificate authority. Point tools at its certificate. `exec()` does not inherit the environment from `start()`, so pass these variables on each command that makes HTTPS requests.

Done when `curl https://example.com/` in an allowed sandbox prints the page instead of a certificate error.

```ts
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST_ENV = { CURL_CA_BUNDLE: CA_PATH, SSL_CERT_FILE: CA_PATH, NODE_EXTRA_CA_CERTS: CA_PATH };
await this.#container.exec(argv, { env: TRUST_ENV });
```

Git uses `GIT_SSL_CAINFO`. Python's `requests` uses `REQUESTS_CA_BUNDLE`.

## 5. Add credentials in a handler

A handler changes a request before the Worker fetches it. Keep secrets in Worker secrets and add them in the handler, so the Container never holds them.

Done when a host sent to `bearer-token` receives your token, and the same host with no rule gets `403`.

```ts
const headers = new Headers(request.headers);
headers.set("Authorization", `Bearer ${this.env.UPSTREAM_TOKEN}`);
return fetch(new Request(request, { headers }));
```

`set()` replaces any `Authorization` header the Container sent. Add a handler for each kind of change: the example also has `audit`, which logs each request and fetches it unchanged.

## 6. Change the rules

Write new rules to storage. The next request follows them. To stop handling a host, remove it from `handlers`. To block a host that is allowed by a pattern, add it to `deny`.

Done when removing a host from `allow` makes the next request to it return `403`.

```ts
setOutboundRules(rules: OutboundRules): OutboundRules {
  this.ctx.storage.kv.put("outbound-rules", rules);
  return rules;
}
```

A request that already reached the entrypoint finishes under the rules it read.

## Before production

- Authenticate every request. Whoever can change the rules decides what the sandbox reaches.
- Validate patterns before storing them. The example accepts lowercase hostnames with `*`.
- `deny` and `allow` see only the hostname. Check the path and method in a handler if they matter, as the coding agents example does for AI Gateway.
