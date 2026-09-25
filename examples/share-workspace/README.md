# Share workspace

Deploy this Worker to share servers that run in a named Container. Each exposed port gets its own URL with a secret token, served through your Worker. A quick tunnel gives a port a public `trycloudflare.com` URL instead. For links with a token, see [Share a preview with a link](https://developers.cloudflare.com/sandbox/previews/preview-a-web-application/#share-a-preview-with-a-link). For tunnels, see [Replace tunnels](https://developers.cloudflare.com/sandbox/sdk/migrate/previews-and-tunnels/#replace-tunnels).

Done when a server in the Container answers at its preview URL and at a quick tunnel URL.

Preview URLs need a wildcard hostname on a zone you own. In `wrangler.jsonc`, replace `preview.example.com` in `PREVIEW_DOMAIN` and `routes` with your own. Add a proxied wildcard DNS record for it and a certificate that covers it, as in [Route preview hostnames to your Worker](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/#route-preview-hostnames-to-your-worker). Then deploy:

```sh
npm run example:share-workspace:deploy
```

Start a server and wait until its port answers:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/servers" \
  --header 'Content-Type: application/json' \
  --data '{"port":8000,"command":["python3","-c","import http.server as h, socketserver as s; s.ThreadingTCPServer((\"\", 8000), h.SimpleHTTPRequestHandler).serve_forever()"]}'
```

The response is `{"state":"ready"}`, or the exit code and log when the command exits first. Servers must listen on all interfaces, not only `127.0.0.1`. `python3 -m http.server` fails in a Container, because it looks up the Container's hostname, which is longer than a DNS label allows. The command above avoids that lookup.

Expose the port:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/ports" \
  --header 'Content-Type: application/json' \
  --data '{"port":8000,"name":"web"}'
```

The response has a URL such as `https://8000-agent-1-tjr45cyczeimwpux.preview.example.com/`. The last part is a random token. A request with the wrong token, or for a port that is not exposed, gets `404`. Pass `token` to choose it yourself: 1 to 16 lowercase letters, digits, or underscores.

| Request                                 | Result                                                   |
| --------------------------------------- | -------------------------------------------------------- |
| `GET /sandboxes/:name/ports`            | Exposed ports and their URLs                             |
| `DELETE /sandboxes/:name/ports/:port`   | Stops serving the URL. `404` if the port is not exposed. |
| `POST /sandboxes/:name/tunnels`         | Opens a quick tunnel to `port`                           |
| `GET /sandboxes/:name/tunnels`          | Open tunnels and their URLs                              |
| `DELETE /sandboxes/:name/tunnels/:port` | Closes the tunnel. `404` if none is open.                |
| `DELETE /sandboxes/:name/execution`     | Destroys the Container                                   |

Open a quick tunnel:

```sh
curl --request POST "$WORKER_URL/sandboxes/agent-1/tunnels" \
  --header 'Content-Type: application/json' \
  --data '{"port":8000}'
```

The response has a URL such as `https://karen-lanes-race-containing.trycloudflare.com`. Its hostname can take a few seconds to resolve. Anyone with the URL reaches the port directly, without your Worker.

An exposed port stays exposed after the Container stops, and its URL returns `503` until a server answers again. Tunnels and servers end with the Container.

## Before production

- Authenticate the control routes. `servers` runs any command you send.
- The Container starts with Internet access, because `cloudflared` needs it. Remove tunnels and set `enableInternet: false` if you only need preview URLs.
- Quick tunnels have no uptime guarantee. Use a named tunnel for production traffic that must bypass your Worker. See [Replace tunnels](https://developers.cloudflare.com/sandbox/sdk/migrate/previews-and-tunnels/#replace-tunnels).
