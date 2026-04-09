# Codex App Server

Runs [OpenAI Codex](https://openai.com/index/introducing-codex/) inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/). A Cloudflare Worker acts as a WebSocket middleman between the browser and the container, running every JSON-RPC message through a composable handler pipeline. An egress proxy intercepts all outbound HTTP from the container to inject the OpenAI API key, while blocking everything else.

```
Browser                     Worker (middleman)              Sandbox Container
 ─────────────           ─────────────────────          ──────────────────────
│             │ WebSocket │  handler pipeline  │ WebSocket │ codex app-server  │
│  Client UI  │◄─────────►│  (inspect/rewrite/ │◄────────►│ :4500             │
│             │           │   intercept)       │          │                   │
│             │           │  egress handlers   │          │ OPENAI_BASE_URL=  │
│             │           │  ┌───────────────┐ │          │ http://api.openai │
│             │           │  │api.openai.com │──► inject API key ──► OpenAI
│             │           │  │github.com     │──► passthrough
│             │           │  │* (catch-all)  │──► 403 Forbidden
│             │           │  └───────────────┘ │
```

## Quick start

```bash
cp .dev.vars.example .dev.vars   # add your OPENAI_API_KEY
npm install
npm run dev
```

Open `http://localhost:8787`. Enter a session name, optionally a repo URL, and click **Connect**.

The first run builds the Docker container (2-3 minutes). Subsequent runs reuse the cached image.

## Deploy

```bash
wrangler secret put OPENAI_API_KEY
npm run deploy
```

## Configuration

Environment variables (set in `.dev.vars` locally, `wrangler secret` in production):

| Variable              | Required | Description                                                                            |
| --------------------- | -------- | -------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`      | yes      | Injected into sandbox HTTP requests via the egress proxy. Never reaches the container. |
| `AUTH_TOKEN`          | no       | If set, clients must provide `Authorization: Bearer <token>` or `?token=<token>`.      |
| `SANDBOX_SLEEP_AFTER` | no       | How long the container stays alive after the last request. Default: `1m`.              |

## How it works

### Session lifecycle

Each WebSocket connection targets `/ws/<session-name>`. The session name maps to a Sandbox Durable Object instance. On connect, the Worker:

1. Destroys any existing sandbox for that session (clean slate)
2. Starts the Codex app-server process inside the container
3. Bridges WebSocket frames between the browser and container through the handler pipeline

The client then runs the connection flow:

1. `sandbox/setup` — clone a git repo into `/workspace` (optional)
2. `initialize` / `initialized` — Codex protocol handshake
3. `thread/start` — create a single conversation thread
4. `turn/start` — send prompts, receive streamed responses

Each session operates a single thread. On disconnect, the sandbox sleeps after `SANDBOX_SLEEP_AFTER`. Reconnecting with the same session name destroys and recreates it.

### Handler pipeline

Every JSON-RPC message flowing through the WebSocket bridge passes through a composable handler pipeline. Each handler can **pass through** (return the message), **rewrite** (return a modified copy), or **intercept** (return `null` after responding via the context object).

```typescript
type MessageHandler = (msg: JsonRpcMessage, ctx: HandlerContext) => JsonRpcMessage | null;

const pipeline = compose(
  log(),                    // observe all traffic
  enforceModel('gpt-5.4'), // force model on thread/turn start
  enforcePolicy({...}),    // override approval + sandbox policies
  sandboxSetup(sandbox),   // intercept sandbox/setup
  sandboxExec(sandbox),    // intercept sandbox/exec
  autoApprove()            // auto-approve tool execution requests
);
```

Built-in handlers (defined in `src/rpc.ts`):

| Handler            | Direction     | Action                                                                           |
| ------------------ | ------------- | -------------------------------------------------------------------------------- |
| `log()`            | both          | Log every message to the Workers console                                         |
| `enforceModel(m)`  | client→server | Force model on `thread/start` and `turn/start`                                   |
| `enforcePolicy(o)` | client→server | Override approval/sandbox policy on `turn/start`, `thread/start`, `command/exec` |
| `autoApprove()`    | server→client | Auto-approve `commandExecution` and `fileChange` requests                        |

Custom handlers (defined in `src/index.ts`):

| Handler           | Direction     | Action                                                                 |
| ----------------- | ------------- | ---------------------------------------------------------------------- |
| `sandboxSetup(s)` | client→server | Intercept `sandbox/setup` — wipe `/workspace` and `gitCheckout` a repo |
| `sandboxExec(s)`  | client→server | Intercept `sandbox/exec` — run a shell command, return stdout/stderr   |

### Egress control

All outbound HTTP from the sandbox is routed through the Worker's egress proxy:

| Host             | Action                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `api.openai.com` | Allowed — Worker injects `OPENAI_API_KEY` header and upgrades to HTTPS |
| `github.com`     | Allowed — passthrough (needed for `sandbox/setup` git clone)           |
| Everything else  | Blocked with `403 Forbidden`                                           |

The container never sees the real API key. It uses `OPENAI_BASE_URL=http://api.openai.com/v1` so requests flow through the HTTP egress proxy, and receives a dummy key (`proxy-injected`). The Worker's `proxyOpenAI` handler swaps in the real key and upgrades to HTTPS before forwarding to OpenAI.

> **Note:** Only HTTP traffic is intercepted via the Container egress proxy. HTTPS interception requires CA injection (see `interceptHttps` in the Sandbox SDK). Raw TCP to non-standard ports bypasses the proxy entirely.

### Browser client

`public/index.html` is a single-file vanilla HTML/CSS/JS client with a dark terminal-meets-chat aesthetic:

- **Session gate** — enter a session name and optional repo URL (persisted in localStorage)
- **Streaming chat** — agent messages stream in via `item/agentMessage/delta` with a blinking cursor
- **Tool call grid** — command executions and file changes render in a two-column grid with collapsible output, exit codes, duration, and color-coded diffs
- **JSON-RPC log** — toggleable side panel showing raw protocol traffic for debugging

The WebSocket endpoint is injected into the HTML via `HTMLRewriter` setting a `data-ws-endpoint` attribute on the `<html>` element.

## Testing

### Integration test

```bash
npm test
```

Runs `run-integration-tests.sh`, which starts `wrangler dev`, waits for readiness, then runs `test.mjs`. The test connects via WebSocket and exercises the full flow: `sandbox/setup` repo clone, `initialize` handshake, `thread/start`, and `turn/start` with streaming delta collection.

### Egress validation

```bash
node test-egress.mjs                    # against localhost:8787
WS_URL=wss://your-app.workers.dev/ws/test node test-egress.mjs  # against production
```

Validates all egress constraints from inside the container:

- `api.openai.com` returns 200 with API key injected (container only has dummy key)
- `github.com` returns 301 (allowed, redirects to HTTPS)
- `example.com` and `httpbin.org` return 403 (blocked)
- Response body contains "Forbidden by egress policy"

## Code structure

```
codex-app-server/
├── Dockerfile               cloudflare/sandbox:0.8.7 + @openai/codex CLI
├── wrangler.jsonc            Worker + Sandbox Durable Object + container config
├── .dev.vars.example         Environment variable template
├── src/
│   ├── index.ts              Worker: egress proxy, WebSocket bridge, sandbox lifecycle
│   └── rpc.ts                JSON-RPC types + composable handler pipeline
├── public/
│   └── index.html            Browser client (session gate, streaming chat, tool grid)
├── test.mjs                  Integration test (full Codex flow over WebSocket)
├── test-egress.mjs           Egress constraint validation test
└── run-integration-tests.sh  Test runner (starts wrangler dev, runs test, tears down)
```
