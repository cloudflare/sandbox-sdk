# WebSocket Tunnel Example

A Cloudflare Worker that tunnels WebSocket connections from a browser to a Bun server running inside a Cloudflare Sandbox using [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/).

## How It Works

This example provides a simple demo that loads a web page with two buttons.

1. connect/disconnect which will establish a WebSocket connection with a Sandbox.
2. send ping will then send a message to the sandbox, which will in turn respond with a message.

The worker will establish a sandbox running a small web server with a WebSocket server.

By default the worker creates a **quick tunnel** via `sandbox.tunnels.get(port)`, which hands back a fresh `*.trycloudflare.com` URL on every container restart — zero configuration needed.

If `TUNNEL_NAME` is set along with a `CLOUDFLARE_API_TOKEN` secret, the worker uses a **named tunnel** instead: `sandbox.tunnels.get(port, { name: TUNNEL_NAME })`. The tunnel binds the stable hostname `<TUNNEL_NAME>.<zone>` and survives container restarts (the SDK rediscovers the tagged Cloudflare resources on re-run). The account id and zone id are inferred from the token when only one of each is reachable; otherwise you must set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_ZONE_ID` explicitly.

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

1. Pick a hostname label (e.g. `ws-demo`) and a zone you control. The resulting hostname will be `<label>.<your-zone>`. Universal SSL only covers `<label>.<zone>`, so the label must be a single DNS label (no dots).
2. Create a Cloudflare API token with the scopes listed below.
3. Stash the token as a secret and set `TUNNEL_NAME`:

    ```bash
    npx wrangler secret put CLOUDFLARE_API_TOKEN
    # then add TUNNEL_NAME=ws-demo to wrangler.jsonc `vars`
    ```

Re-run `npm run dev` and the demo will use the named tunnel.

#### Required token scopes

Create the token from **My Profile → API Tokens → Create Token → Custom token**. The exact UI labels for each permission are:

| UI dropdowns | Used for |
| --- | --- |
| **Account** · **Cloudflare Tunnel** · **Edit** | Create, look up, and delete tunnels |
| **Zone** · **DNS** · **Edit** | Upsert and delete the proxied `CNAME` for `<label>.<zone>` |
| **Zone** · **Zone** · **Read** | Look up the zone's name to derive `<label>.<zone>` |
| **Account** · **Account Settings** · **Read** | Optional. Lets the SDK infer `CLOUDFLARE_ACCOUNT_ID` from the token. Skip this if you set the account id explicitly. |

Under **Account Resources**, scope to the account that owns the tunnel. Under **Zone Resources**, scope to the specific zone you want to bind to.

Both **User API Tokens** (created from *My Profile → API Tokens*) and **Account API Tokens** (created from *Manage Account → Account API Tokens*; the secret starts with `cfat_`) work. The SDK detects which kind you have and uses the appropriate introspection endpoint.

#### When to set the env vars explicitly

If the token has access to **more than one account** or **more than one zone**, inference is ambiguous and the SDK throws a clear error asking you to set the relevant env var. In that case add the missing id(s) to `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "SANDBOX_TRANSPORT": "rpc",
  "TUNNEL_NAME": "ws-demo",
  "CLOUDFLARE_ACCOUNT_ID": "<your account id>",
  "CLOUDFLARE_ZONE_ID": "<your zone id>"
}
```

Setting these also lets you drop the **Account Settings: Read** and **Zone: Read** scopes from the token, since inference no longer runs.

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
