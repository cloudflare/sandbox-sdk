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

We refer to the current directory as the "host" server and the one loaded in the sandbox as the "sandbox" server. The Cloudflare services (workers, assets, storage etc.) are referred to as wrangler. Configuration for the host Vite server is in the root vite.config.js, the Cloudflare config is in wrangler.jsonc and the sandbox Vite config is in sandbox-app/vite.config.js.
