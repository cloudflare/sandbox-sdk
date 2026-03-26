# Vite dev server with Cloudflare Sandbox

An example demonstrating a Vite React application embedded in a sandbox hosted by a Vite React application. A "counter" script changes the sandbox App.jsx file to demonstrate hot module reloading (HMR).

## Setup

Start the development server:

```bash
npm start
```

## Usage

This is a non-interactive demo. The counter in the host frame will increment once per second using the host HMR server. The counter in the iframed sandbox will decrement once per second to demonstrate that the hot module reloading is working over websockets between browser and sandbox.

## Deploy

```bash
npm run deploy
```

## Implementation Notes

Hosting two Vite servers on the same port along with the Cloudflare wrangler server has the potential for unexpected behavior.

We refer to the current directory as the "host" server and the one loaded in the sandbox as the "sandbox" server. The Cloudflare services (workers, assets, storage etc.) are referred to as wrangler. Configuration for the host Vite server is in the root vite.config.js, the Cloudflare config is in wrangler.jsonc and the sandbox Vite config is in sandbox-app/vite.config.js.

This repository has been setup in a way to reduce the confusion.

1.  We assume static assets will be served by Cloudflare. The host Vite server has `appType` set to `"custom"` to disable Vite handling HTML.
2.  A `base` path of `/_/` has been set on the sandbox Vite server to minimize path conflicts with the Cloudflare asset server. If this still causes issues or is not suitable for your application then setting `assets.run_worker_first` can act as a workaround (see note below).
3.  The host hot module reloading server is configured under `server.hmr` and has been set to run on a different port to the Vite dev server. This reduces the chance of conflicts between the host and sandbox HMR websockets.
4.  We configure the host server via environment variables, namely `base` via `VITE_BASE`, `server.port` via `VITE_PORT` and `server.hmr.clientPort` via the `VITE_HMR_CLIENT_PORT` environment variables so that the sandboxed HMR server is configured correctly for both development and production config.

### Troubleshooting

Depending on your Vite configuration and application setup the above setup may still not work.

1.  Set `run_worker_first`. This can be used to explicitly run the worker for certain paths, such as the Vite base, this might be needed if your sandbox is not receiving expected requests due
    to Cloudflare handling them too early.

    ```jsonc
    // wrangler.jsonc
    "assets": {
        "not_found_handling": "none",
        "run_worker_first": ["/_/*"]
    },
    ```

2.  Always run the worker before Cloudflare asset handling. This will be needed if your sandbox server cannot use the Vite `base` setting, for example if you're running external code with little control over routing. Note that with this approach you will either need to exclude any assets you explicitly want served by Cloudflare or handle these manually in your worker with a service binding.

    ```jsonc
    // wrangler.jsonc
    "assets": {
        "binding": "Assets",
        "not_found_handling": "none",
        "run_worker_first": ["/*", "!/assets"]
    },
    ```

    With service binding:

    ```js
    async fetch(request, env) {
      // Handle any preview URL requests first.
      const response = await proxyToSandbox(request, env);
      if (response) return response

      // worker code

      // Finally fallback to serving assets.
      return env.Assets.fetch(request);
    }
    ```
