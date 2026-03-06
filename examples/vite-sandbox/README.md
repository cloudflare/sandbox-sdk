# Vite dev server with Cloudflare Sandbox

An example demonstrating a Vite React application embedded in a sandbox hosted by a Vite React application. A "counter" script changes the sandbox App.jsx file to demonstrate hot module reloading (HMR).

## Setup

Start the development server:

```bash
npm start
```

## Usage

This is a non-interactive demo. The counter in the iframed sandbox will increment once per second to demonstrate that the hot module reloading is working over websockets between browser and sandbox.

## Deploy

```bash
npm run deploy
```

## Implementation Notes

Hosting two Vite servers on the same port along with the Cloudflare wrangler server has the potential for unexpected behavior.

We refer to the current directory as the "host" server and the one loaded in the sandbox as the "sandbox" server. The Cloudflare services (workers, assets, storage etc.) are referred to as wrangler. Configuration for the host Vite server is in the root vite.config.js, the Cloudflare config is in wrangler.jsonc and the sandbox Vite config is in sandbox-app/vite.config.js.

This repository has been setup in a way to reduce the confusion.

 1. We assume static assets will be served by Cloudflare. The host Vite server has `appType` set to `"custom"` to disable Vite handling HTML.
 2. The hot module reloading server is configured under `server.hmr` has been set to run on a different port to the Vite dev server. This reduces the chance of conflicts between the host and sandbox HMR websockets.
 3. Wrangler has been configured to pass all requests through to the worker rather than serving static assets first. This ensures that we have the opportunity to proxy requests to the sandbox before serving assets.

    The code looks like:

    ```ts
    async fetch(request, env) {
      // 1. Attempt to proxy the request to a Sandbox.
      const proxiedResponse = await proxyToSandbox(request, env);
      if (proxiedResponse) {
        return proxiedResponse;
      }

      // 2. Worker specific code follows...

      // 3. Otherwise fallback to serving static assets (including index.html)
      const url = new URL(request.url);
      if (url.pathname.endsWith("/")) {
        url.pathname = `${url.pathname}index.html`;
      }
      return env.Assets.fetch(new Request(url.href, request));
    }
    ```
 4. We pass the host port via the `VITE_CLIENT_PORT` environment variable so that the HMR server is configured correctly.
