# Codex App Server

Runs [OpenAI Codex](https://openai.com/index/introducing-codex/) inside a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/). A Cloudflare Worker acts as a WebSocket middleman between the browser and the container, running every JSON-RPC message through a composable handler pipeline. An egress proxy intercepts all outbound HTTP and HTTPS from the container to inject the OpenAI API key, while blocking everything else.

```
Browser                     Worker (middleman)              Sandbox Container
 ─────────────           ─────────────────────          ──────────────────────
│             │ WebSocket │  handler pipeline  │ WebSocket │ codex app-server  │
│  Client UI  │◄─────────►│  (inspect/rewrite/ │◄────────►│ :4500             │
│             │           │   intercept)       │          │                   │
│             │           │  egress handlers   │          │ OPENAI_BASE_URL=  │
│             │           │  ┌───────────────┐ │          │ http://api.openai │
│             │           │  │api.openai.com │──► inject API key ──► OpenAI
│             │           │  │github.com     │──► upgrade to HTTPS ──► GitHub
│             │           │  │* (catch-all)  │──► 403 Forbidden
│             │           │  └───────────────┘ │
│             │           │                     │
│             │           │  enableInternet=false│
│             │           │  interceptHttps=true │
```

## Quick start

```bash
cp .dev.vars.example .dev.vars   # add your OPENAI_API_KEY
npm install
npm run dev
```

Open `http://localhost:8787`. Enter a session name, optionally a repo URL, and click **Connect**.

The first run builds the Docker container (2-3 minutes). Subsequent runs reuse the cached image.

> **Note:** HTTPS interception and `enableInternet = false` require the Cloudflare runtime environment. Local development via `wrangler dev` uses `enableInternet = true` with HTTP-only interception.

## Deploy

```bash
wrangler secret put OPENAI_API_KEY
npm run deploy
```

## Configuration

Environment variables (set in `.dev.vars` locally, `wrangler secret` in production):

| Variable              | Required | Description                                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`      | yes      | Injected into sandbox HTTP/HTTPS requests via the egress proxy. Never reaches the container. |
| `AUTH_TOKEN`          | no       | If set, clients must provide `Authorization: Bearer <token>` or `?token=<token>`.            |
| `SANDBOX_SLEEP_AFTER` | no       | How long the container stays alive after the last request. Default: `1m`.                    |

## How it works

### Sandbox subclass

The Worker exports a `Sandbox` subclass with two security settings:

```typescript
export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false; // block direct internet at the network level
  interceptHttps = true; // intercept HTTPS via Cloudflare CA cert injection
}
```

- **`enableInternet = false`** — disables direct outbound network access from the container. Only traffic handled by `outboundByHost` or `outbound` handlers can leave.
- **`interceptHttps = true`** — injects a Cloudflare CA certificate into the container so HTTPS traffic flows through the same egress handlers as HTTP. Without this, HTTPS would bypass the proxy.

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

The Sandbox subclass combines three layers of network control to minimize data exfiltration risk:

1. **`enableInternet = false`** — blocks all direct outbound connections at the network level. Raw TCP to hosts not in `outboundByHost` is refused.
2. **`interceptHttps = true`** — HTTPS traffic is intercepted via a Cloudflare-injected CA certificate, so it flows through the same handlers as HTTP.
3. **`outboundByHost` + `outbound`** — application-level allowlist with a deny-by-default catch-all.

| Host             | Protocol     | Action                                                             |
| ---------------- | ------------ | ------------------------------------------------------------------ |
| `api.openai.com` | HTTP + HTTPS | Allowed — Worker injects `OPENAI_API_KEY` and upgrades to HTTPS    |
| `github.com`     | HTTP + HTTPS | Allowed — upgrades to HTTPS (needed for `sandbox/setup` git clone) |
| Everything else  | HTTP + HTTPS | Blocked with `403 Forbidden`                                       |
| Non-HTTP traffic | Raw TCP      | Blocked by `enableInternet = false` for non-allowed hosts          |

The container never sees the real API key. It uses `OPENAI_BASE_URL=http://api.openai.com/v1` so requests flow through the egress proxy, and receives a dummy key (`proxy-injected`). The Worker swaps in the real key and upgrades to HTTPS before forwarding to OpenAI.

> **Note:** DNS resolution is unrestricted, but without network access to blocked hosts, DNS alone does not enable data exfiltration.

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

Validates egress constraints from inside the container:

- `api.openai.com` returns 200 with API key injected (container only has dummy key)
- `github.com` returns 301 (allowed)
- `example.com` and `httpbin.org` return 403 (blocked)
- Response body contains "Forbidden by egress policy"

When deployed with `interceptHttps = true`, HTTPS requests to blocked hosts also return 403. With `enableInternet = false`, raw TCP connections to non-allowed hosts time out.

## Code structure

```
codex-app-server/
├── Dockerfile               cloudflare/sandbox:0.9.0 + @openai/codex CLI
├── wrangler.jsonc            Worker + Sandbox Durable Object + container config
├── .dev.vars.example         Environment variable template
├── src/
│   ├── index.ts              Worker: Sandbox subclass, egress proxy, WebSocket bridge
│   └── rpc.ts                JSON-RPC types + composable handler pipeline
├── public/
│   └── index.html            Browser client (session gate, streaming chat, tool grid)
├── test.mjs                  Integration test (full Codex flow over WebSocket)
├── test-egress.mjs           Egress constraint validation test
└── run-integration-tests.sh  Test runner (starts wrangler dev, runs test, tears down)
```
