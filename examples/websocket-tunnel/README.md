# WebSocket Tunnel Example

A Cloudflare Worker that tunnels WebSocket connections from a browser to a Bun server running inside a Cloudflare Sandbox.

## How It Works

This example provides a simple demo that loads a web page with two buttons.

1. connect/disconnect which will establish a WebSocket connection with a Sandbox.
2. send ping will then send a message to the sandbox, which will in turn respond with a message.

The worker will establish a sandbox running a small web server with a WebSocket server.

In the worker the `proxyToSandbox()` helper ensures that the WebSocket connection is correctly proxied to the underlying sandbox.

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

The first run will build the Docker container (2–3 minutes). Subsequent runs are much faster.

## Testing

Open `http://localhost:8787` in a browser. Click **Connect** to open the WebSocket connection, then **Send ping** to start the exchange. The log panel shows each message sent and received.

## Deploy

```bash
npm run deploy
```

> **Note:** `exposePort` requires a custom domain with wildcard DNS (`*.yourdomain.com`). It does not work with `.workers.dev` domains. See the [Cloudflare Sandbox documentation](https://developers.cloudflare.com/sandbox/) for production setup instructions.

After first deployment, wait 2–3 minutes for container provisioning before opening the page.

## Next Steps

See the [Sandbox SDK documentation](https://developers.cloudflare.com/sandbox/) for:

- Token-based authentication for exposed ports
- Multiple concurrent sandbox sessions
- Streaming command output
- Custom Docker base images
