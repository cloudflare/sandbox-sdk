# Share a port

Give a server in a Container a URL that someone else can open. Done when a server in the Container answers at a URL with a secret token, and at a quick tunnel URL.

There are two ways. A preview URL goes through your Worker, which checks a token before forwarding the request to the port. A tunnel runs `cloudflared` in the Container and reaches the port without your Worker. The [share workspace example](../examples/share-workspace) is the complete Worker. To preview one dev server for its own sandbox, see [Preview a web app](preview-a-web-app.md).

## 1. Build the image

Copy `cloudflared` from its official image if you need tunnels. It is a static binary, so it runs on any base image.

Done when the image runs `cloudflared --version`.

```dockerfile
FROM cloudflare/cloudflared:2026.3.0 AS cloudflared

FROM debian:trixie-slim
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
```

## 2. Start the server

Start it with `exec()`, write its output to a file, and ignore the process streams, as in [Preview a web app](preview-a-web-app.md#3-start-the-dev-server). Then retry `getTcpPort(port).fetch()` until the port answers or the process exits.

Done when a request to the port gets any HTTP response.

The server must listen on all interfaces. A server that listens only on `127.0.0.1` never answers `getTcpPort()`.

`python3 -m http.server` exits with `UnicodeEncodeError: 'idna' codec can't encode characters`. It looks up the Container's hostname, which is 64 characters, one more than a DNS label allows. Other tools that resolve their own hostname fail the same way. For Python, serve with `socketserver`, which skips the lookup:

```sh
python3 -c 'import http.server as h, socketserver as s; s.ThreadingTCPServer(("", 8000), h.SimpleHTTPRequestHandler).serve_forever()'
```

## 3. Give each port a URL

Route a wildcard hostname to your Worker, as in [Preview a web app](preview-a-web-app.md#2-give-each-sandbox-its-own-origin). Put the port, the sandbox name, and a random token in the first label, such as `8000-agent-1-tjr45cyczeimwpux.preview.example.com`. Store the token in the Durable Object.

Done when exposing a port returns its URL, and exposing it again returns the same URL.

```ts
const stored = {
  name: request.name ?? existing?.name ?? null,
  token: request.token ?? existing?.token ?? randomToken(),
  createdAt: existing?.createdAt ?? new Date().toISOString(),
};
this.ctx.storage.kv.put(`port:${request.port}`, stored);
```

The example draws 16 characters from a 32-letter alphabet, so each random byte maps to a letter without bias. That gives 80 bits.

A DNS label holds at most 63 characters. With a five-digit port and a 16-character token, sandbox names up to 40 characters fit. Check the length before you store the port.

To stop serving a port, delete its key.

## 4. Check the token and forward

In the Worker, parse the label and send the request to the sandbox by name. In the Durable Object, compare the token with the stored one, then forward the request to the port.

Done when the right token serves the page, and a wrong token returns `404`.

```ts
override async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = PREVIEW_LABEL_PATTERN.exec(url.hostname.slice(0, -`.${this.env.PREVIEW_DOMAIN}`.length));
  if (match === null) return notFound();
  const port = Number(match[1]);
  const stored = this.ctx.storage.kv.get<StoredPort>(`port:${port}`);
  if (stored === undefined || !tokensMatch(stored.token, match[3])) return notFound();
  if (!this.#container.running) return new Response("Sandbox is not running", { status: 503 });

  url.protocol = "http:";
  return this.#container.getTcpPort(port).fetch(new Request(url, request));
}
```

Compare every character, so the time the comparison takes does not reveal how much of a guess matched. Return the same `404` for an unknown port and a wrong token. HTTP, streaming bodies, and WebSockets pass through `getTcpPort().fetch()`.

## 5. Open a quick tunnel

A quick tunnel gives the port a random `trycloudflare.com` URL without a Cloudflare account or zone. Start `cloudflared` in the background, with its output in a file and its process ID beside it. The tunnel is ready when the log has the URL and `Registered tunnel connection`.

Done when the `trycloudflare.com` URL serves the page.

```ts
await container.exec(
  [
    "/bin/sh",
    "-c",
    'dir=$1; port=$2; mkdir -p "$dir"; echo "$$" >"$dir/pid"; ' +
      'exec cloudflared tunnel --no-autoupdate --url "http://localhost:$port" >"$dir/log" 2>&1',
    "tunnel",
    `/run/tunnels/${port}`,
    String(port),
  ],
  { stdout: "ignore", stderr: "ignore" },
);
```

`cloudflared` needs Internet access, so start the Container with `enableInternet: true`. With `false` and no intercepts, DNS lookups get no answer, and it exits before it gets a URL. The URL's hostname can take a few seconds to resolve after the tunnel is ready.

To close the tunnel, send `SIGTERM` to the process ID in the file. The URL then returns `530`. The tunnel also ends with the Container.

Anyone with a quick tunnel URL reaches the port without your Worker. Quick tunnels have no uptime guarantee.

## 6. Use a named tunnel

A named tunnel serves a hostname on your zone, and keeps it when `cloudflared` or the Container restarts. Create one with the [Cloudflare Tunnel API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/), with `config_src: "cloudflare"`. The response includes the tunnel's token. Give the tunnel a public hostname, as described in [Cloudflare Tunnel routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/).

Done when the tunnel shows as healthy in the dashboard or the API.

Pass the token in the environment, not in the command line, and point `--url` at the port:

```ts
await container.exec(
  [
    "/bin/sh",
    "-c",
    'exec cloudflared tunnel --no-autoupdate run --url "http://localhost:$1" >/run/named-tunnel.log 2>&1',
    "tunnel",
    String(port),
  ],
  { env: { TUNNEL_TOKEN: token }, stdout: "ignore", stderr: "ignore" },
);
```

Give each sandbox its own tunnel. Every `cloudflared` process that runs with the same token joins the same tunnel as a [replica](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/deploy-replicas/), so requests for its hostname can reach any sandbox that runs it. Store the tunnel token as a secret, or create the tunnel from your Worker with an API token that can edit tunnels and DNS. Delete the tunnel and its DNS record when the sandbox no longer needs them.

## Before production

- Authenticate the routes that start servers and expose ports.
- A preview token is a password in a URL. It can leak through browser history, logs, and `Referer` headers. For private previews, also require a session on the preview origin.
- Keep previews on a domain your app does not use for cookies, as in [Preview a web app](preview-a-web-app.md#2-give-each-sandbox-its-own-origin).
- Internet access for `cloudflared` also lets code in the Container reach the Internet. If you only need preview URLs, start the Container with `enableInternet: false`.
