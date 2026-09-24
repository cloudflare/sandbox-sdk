# Move preview URLs and tunnels

In 0.12, `exposePort()` issued a preview URL with a token, `proxyToSandbox()` routed it, and `sandbox.tunnels` ran `cloudflared` for you. Now your Worker routes preview hostnames to your Durable Object, which checks the token and forwards the request to the port. Tunnels are `cloudflared` processes that you start in the Container. [Share a port](../share-a-port.md) builds both. The [share workspace example](../../examples/share-workspace) is the complete Worker.

## 1. Replace `exposePort()` and `proxyToSandbox()`

Store a token for each exposed port, as in [step 3](../share-a-port.md#3-give-each-port-a-url) of the how-to. Replace `proxyToSandbox()` with the routing and token check in [step 4](../share-a-port.md#4-check-the-token-and-forward).

Done when a preview URL serves the page, and a wrong token returns `404`.

```ts
// 0.12
const { url } = await sandbox.exposePort(8000, { hostname: "preview.example.com" });
const response = await proxyToSandbox(request, env);

// Now, with the example's Durable Object
const { url } = await sandbox.exposePort("agent-1", { port: 8000 });
return env.SANDBOX.getByName(sandboxName).fetch(request);
```

The example keeps 0.12's hostname format, `<port>-<sandbox name>-<token>.<domain>`, and its rules for custom tokens. To keep a preview URL you already shared, expose the port again with its old token as `token`. Set the domain once in `PREVIEW_DOMAIN` instead of passing `hostname` to each call.

| 0.12                        | Now                                                                               |
| --------------------------- | --------------------------------------------------------------------------------- |
| `exposePort(port, options)` | `exposePort()` in the example stores the token in Durable Object storage.         |
| `unexposePort(port)`        | `unexposePort()` deletes the stored token.                                        |
| `getExposedPorts(hostname)` | `listPorts()` returns every exposed port with its URL.                            |
| `isPortExposed(port)`       | Read the port's key from Durable Object storage.                                  |
| `validatePortToken()`       | The Durable Object's `fetch()` compares the token before it forwards the request. |
| `proxyToSandbox()`          | Parse the hostname in the Worker, then call the Durable Object's `fetch()`.       |
| `wsConnect(request, port)`  | `getTcpPort(port).fetch(request)`. WebSockets pass through.                       |

0.12 accepted ports from 1024 through 65535, except 3000. Any port from 1 through 65535 works now, but ports below 1024 need a server that runs as `root`.

0.12 required `exposePort()` again after the Container restarted, and kept the token. The example keeps a port exposed until you unexpose it. Its URL returns `503` while nothing listens.

## 2. Replace `startProcess()` with `waitForPort()`

Start the server in the background and retry `getTcpPort(port).fetch()` until it answers, as in [step 2](../share-a-port.md#2-start-the-server). The example's `servers` route does both, and returns the exit code and log when the server exits first.

Done when starting a server returns `ready`.

Servers must listen on all interfaces, as they did in 0.12. `python3 -m http.server` fails in a Container, because the Container's hostname is longer than a DNS label allows. Step 2 of the how-to shows a command that works.

## 3. Replace quick tunnels

Replace `sandbox.tunnels.get(port)` with a `cloudflared` process, as in [step 5](../share-a-port.md#5-open-a-quick-tunnel). Copy `cloudflared` into your image, and start the Container with `enableInternet: true`.

Done when the `trycloudflare.com` URL serves the page.

| 0.12                    | Now                                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| `tunnels.get(port)`     | `openTunnel()` in the example, or the same tunnel if one is running  |
| `tunnels.list()`        | `listTunnels()` lists tunnels whose `cloudflared` process is running |
| `tunnels.destroy(port)` | `closeTunnel()` sends `SIGTERM` to `cloudflared`                     |

The example keeps each tunnel's URL and process ID in the Container's file system, so tunnels end with the Container, as quick tunnels did in 0.12.

## 4. Replace named tunnels

0.12's `tunnels.get(port, { name })` created a tunnel and a DNS record through the Cloudflare API, using `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_ZONE_ID`. Choose one of these instead.

Done when each named tunnel you used has a replacement.

- To give each port a hostname on your zone, use preview URLs. They need no API token, and your Worker can authenticate each request.
- For traffic that must bypass your Worker, run a named tunnel, as in [step 6](../share-a-port.md#6-use-a-named-tunnel). Create one tunnel for each sandbox, pass its token as `TUNNEL_TOKEN`, and delete the tunnel and its DNS record when the sandbox no longer needs them. 0.12 created the tunnel with `config_src: "cloudflare"` and pointed a proxied `CNAME` record at `<tunnel ID>.cfargotunnel.com`.

0.12 started named tunnels again after the Container restarted. Start `cloudflared` again after each `start()`, with the same token.
