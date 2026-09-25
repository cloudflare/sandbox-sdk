# Outbound workspace

Deploy this Worker to run commands in a named Container whose outbound HTTP and HTTPS requests follow rules you can change while it runs. Rules can block hosts, allow them, or send them to a handler in the Worker that adds a credential. For outbound interception, see [Handle outbound traffic](https://developers.cloudflare.com/sandbox/network/handle-outbound-traffic/) and [`interceptOutboundHttp()`](https://developers.cloudflare.com/durable-objects/api/container/#interceptoutboundhttp).

Done when changing a rule changes what the next `curl` in the Container can reach, without restarting it.

```sh
npm run example:outbound-workspace:deploy
```

Optionally, set a token for the `bearer-token` handler to send:

```sh
npx wrangler secret put UPSTREAM_TOKEN --config examples/outbound-workspace/wrangler.jsonc
```

A new sandbox allows nothing:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/commands" \
  --header 'Content-Type: application/json' \
  --data '{"argv":["curl","-sS","https://example.com/"]}'
```

The command's output is `example.com is not allowed`. Allow the host, then run the same command again. It now prints the page:

```sh
curl --request PUT "$WORKER_URL/sandboxes/agent-1/outbound-rules" \
  --header 'Content-Type: application/json' \
  --data '{"allow":["example.com"]}'
```

A rule set has three lists, checked in order:

| Field      | Matching host                                        |
| ---------- | ---------------------------------------------------- |
| `deny`     | Is blocked, even if it has a handler or is allowed   |
| `handlers` | Goes to the named handler: `bearer-token` or `audit` |
| `allow`    | Is fetched unchanged. `["*"]` allows every host.     |

`*` matches any run of characters, so `*.example.com` matches `api.example.com` but not `example.com`. An exact hostname in `handlers` wins over a pattern. `PUT` replaces the whole rule set. `GET` returns it.

Send one host to the token handler, then check the header the server receives:

```sh
curl --request PUT "$WORKER_URL/sandboxes/agent-1/outbound-rules" \
  --header 'Content-Type: application/json' \
  --data '{"handlers":{"httpbin.org":"bearer-token"}}'
curl --request POST "$WORKER_URL/sandboxes/agent-1/commands" \
  --header 'Content-Type: application/json' \
  --data '{"argv":["curl","-sS","https://httpbin.org/headers"]}'
```

The response shows `Authorization: Bearer` with your token, which never enters the Container. The same request over `http://` gets `403`, because the Worker fetches with the Container's scheme and would send the token unencrypted. Switch the host to `audit` to log each request to Workers Logs instead. Remove it from `handlers` to stop handling it.

Only HTTP on port 80 and HTTPS on port 443 leave the Container. Connections to other ports time out, whatever the rules say. HTTPS to a bare IP address fails, because interception needs a hostname.

Rules are kept in Durable Object storage. Reset the Container, and the next one follows the same rules:

```sh
curl --request DELETE "$WORKER_URL/sandboxes/agent-1/execution"
```

Authenticate in production. This Worker runs any command, and changes the rules for anyone who asks.
