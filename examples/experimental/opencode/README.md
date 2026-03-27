# OpenCode on Cloudflare Sandbox

> **Experimental** — this is a proof-of-concept, not a production-ready example.

Runs [OpenCode](https://opencode.ai) inside a Cloudflare Sandbox, with all tool
calls (bash, read, write, edit, grep, glob, list) routed to an isolated
CodeSandbox rather than the container's own filesystem.

## How It Works

Two Sandbox containers back this Worker:

- **OpenCodeSandbox** — runs `opencode serve` with a custom plugin that starts a
  [Cap'n Web](https://github.com/nicowillis/capnweb) WebSocket server on port 3001.
- **CodeSandbox** — one instance per OpenCode session; receives all tool calls
  forwarded from the plugin via RPC.

When a request arrives the Worker calls `createOpencodeServer`, which starts
OpenCode inside the `OpenCodeSandbox` Durable Object. The DO connects back to the
plugin over Cap'n Web and exposes a `SandboxRpcApi` — a typed RPC target the plugin
uses to route `exec`, `readFile`, and `writeFile` calls to the correct per-session
`CodeSandbox`.

The Worker then proxies the request to OpenCode via `proxyToOpencode`, which handles
the SPA redirect (`?url=` → `app.opencode.ai`) and all API calls.

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) 4.x (`npm i -g wrangler`)
- [Docker](https://www.docker.com) (for local container builds)
- An OpenAI API key

## Setup

1. Install dependencies from the repo root:

   ```bash
   npm install
   npm run build
   ```

2. Copy the example env file and add your key:

   ```bash
   cp .dev.vars.example .dev.vars
   # edit .dev.vars and set OPENAI_API_KEY
   ```

## Running Locally

```bash
cd examples/experimental/opencode
npm run dev
```

The first run builds both Docker images (a few minutes). Subsequent runs are faster.

Once running, you can connect in two ways:

**Run a single command non-interactively:**

```bash
opencode run \
  --model opencode/big-pickle \
  --attach http://localhost:8787 \
  'Write a single nodejs script called random.js that prints a random number between 0 and 100 to stdout, then run it and give me back that number and echo out the contents of the file'
```

**Open the interactive UI:**

```bash
opencode attach http://localhost:8787
```

## Deploy

```bash
npm run deploy
```

> **Note:** this example requires a custom domain with wildcard DNS (`*.yourdomain.com`)
> for preview URL routing. `.workers.dev` domains do not support the required subdomain
> patterns. See the [Cloudflare Sandbox docs](https://developers.cloudflare.com/sandbox/)
> for production setup.

## Project Structure

```
worker/src/index.ts              Worker, DOs, and SandboxRpcApi
opencode-sandbox/
  plugins/cloudflare-sandbox.ts  OpenCode plugin (Cap'n Web WS server)
  cloudflare-sandbox/rpc.ts      Plugin-side RPC session
  tools/                         Custom tool implementations
Dockerfile.opencode-sandbox      Image for the OpenCode container
Dockerfile.code-sandbox          Image for the isolated code execution container
wrangler.jsonc                   Wrangler config with two container DO bindings
```

## Learn More

- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [OpenCode documentation](https://opencode.ai/docs)
