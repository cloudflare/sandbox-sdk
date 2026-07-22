# Reproduction for sandbox-sdk #829

Minimal reproduction for **STALE_PREVIEW_URL on every preview request despite healthy container (0.11.0)**.

It pins both the Worker SDK and desktop image to `0.11.0`. The trigger:

1. boots the desktop container and verifies `exec()` works;
2. starts the desktop and verifies `http://127.0.0.1:6080/vnc.html` returns 200 from inside the container;
3. calls `exposePort(6080)`;
4. sends three generated preview-host requests through `proxyToSandbox()`; and
5. compares the preview responses with the expected noVNC HTML response.

The synthetic `repro.invalid` hostname bypasses only wildcard DNS/TLS setup. Requests still traverse the SDK's normal `proxyToSandbox` → Sandbox Durable Object → runtime validation → port-forwarding path.

## Run locally

Docker is required.

```sh
npm install
npm start
```

Open the printed URL and press **Trigger bug**. On the tested local Workers runtime, all three preview requests returned HTTP 200 noVNC HTML, so the report was **not reproduced locally**.

## Deploy on a Containers-enabled Cloudflare account

The checked-in `deploy` script uses `--temporary --containers-rollout=none` so the mandatory demonstration UI can be published to a temporary account. Temporary accounts cannot provision Containers, so their button reports a container-start error.

To exercise the reproduction in production, deploy from a normal account with Containers enabled:

```sh
npm run build
npx wrangler deploy --containers-rollout=immediate
```

A real wildcard route is not needed for this harness because it constructs the same preview hostname and invokes `proxyToSandbox()` internally.
