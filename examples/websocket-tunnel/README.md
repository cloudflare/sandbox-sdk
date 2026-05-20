# WebSocket Tunnel Example

A Cloudflare Worker that tunnels WebSocket connections from a browser to a Bun server running inside a Cloudflare Sandbox using [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/).

## How It Works

This example provides a simple demo that loads a web page with two buttons.

1. connect/disconnect which will establish a WebSocket connection with a Sandbox.
2. send ping will then send a message to the sandbox, which will in turn respond with a message.

The worker will establish a sandbox running a small web server with a WebSocket server.

By default the worker creates a **quick tunnel** via `sandbox.tunnels.get(port)`, which hands back a fresh `*.trycloudflare.com` URL on every container restart — zero configuration needed.

If `TUNNEL_NAME`, `CLOUDFLARE_ZONE_ID`, and the `CLOUDFLARE_API_TOKEN` secret are all set, the worker uses a **named tunnel** instead: `sandbox.tunnels.get(port, { name: TUNNEL_NAME })`. The tunnel binds the stable hostname `<TUNNEL_NAME>.<zone>` and survives container restarts (the SDK rediscovers the tagged Cloudflare resources on re-run).

## Setup

1. From the project root, run:

```bash
npm install
npm run build
```

2. Run locally:

```bash
cd examples/websocket-tunnel # if you're not already here
npm run dev
```

### Optional: named tunnel under your zone

To bind the demo to a stable hostname instead of `*.trycloudflare.com`:

1. Pick a hostname label (e.g. `ws-demo`) and a zone you control (e.g. `example.com`). The resulting hostname will be `ws-demo.example.com`.
2. Edit `wrangler.jsonc` and set `CLOUDFLARE_ZONE_ID` and `TUNNEL_NAME` under `vars` (the file has commented-out placeholders).
3. Create a Cloudflare API token with **Account → Cloudflare Tunnel → Edit** and **Zone → DNS → Edit** permissions, then stash it as a secret:

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

Re-run `npm run dev` and the demo will use the named tunnel. Universal SSL only covers `<label>.<zone>`, so the label must be a single DNS label (no dots).

The first run will build the Docker container (2–3 minutes). Subsequent runs are much faster.

## Testing

Open `http://localhost:8787` in a browser. Click **Connect** to open the WebSocket connection, then **Send ping** to start the exchange. The log panel shows each message sent and received.

## Deploy

```bash
npm run deploy
```

## Next Steps

See the [Sandbox SDK documentation](https://developers.cloudflare.com/sandbox/) for:

- Token-based authentication for exposed ports
- Multiple concurrent sandbox sessions
- Streaming command output
- Custom Docker base images
