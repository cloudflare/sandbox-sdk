# OpenCode Sandbox — Agent Context

Experimental example: OpenCode running inside a Cloudflare Sandbox, with all tool
calls (bash, read, write, edit, grep, glob, list) routed through a second isolated
CodeSandbox rather than the local filesystem.

## Architecture

```
Browser
  │
  ├── SPA ──► Worker ──?url= redirect──► app.opencode.ai
  │
  └── API ──► Worker ──► OpenCodeSandbox DO ──► opencode serve :4096
                │                  ▲
                │                  │ Cap'n Web RPC (WebSocket :3001)
                │                  ▼
                │           sandbox plugin (inside opencode process)
                │
                └──► CodeSandbox DO (per session) ──► exec / readFile / writeFile
```

### Two containers

- **OpenCodeSandbox** (`OPENCODE`) — Single instance running `opencode serve` with the
  custom sandbox plugin installed. Based on `cloudflare/sandbox` + opencode CLI.
- **CodeSandbox** (`SANDBOX`) — One instance per OpenCode session, isolated code
  execution. Based on `cloudflare/sandbox` with a matching `/home/user/project` layout.

### Request flow

1. Worker calls `createOpencodeServer` on the `OpenCodeSandbox` DO (idempotent).
2. `OpenCodeSandbox.onStart` establishes a Cap'n Web WebSocket to the plugin on port 3001.
3. The plugin receives a `SandboxRpcApi` stub — a `RpcTarget` that exposes a `sandbox(sessionId)` method.
4. OpenCode's custom tools call `sandboxApi.sandbox(sessionId).exec(...)` etc.
5. The DO's `SandboxRpcApi` routes each call to `getSandbox(env.SANDBOX, "session-{id}")`.
6. Worker's `proxyToOpencode` handles the SPA (`?url=` redirect) and API proxying.

### Cap'n Web bridge

The bridge is established inside the `OpenCodeSandbox` DO (not the Worker) so the
WebSocket persists across requests. `connectBridge()` is called from `onStart` and
guards against double-connection with `bridgeConnected`.

## File Map

| Path                                             | Purpose                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `worker/src/index.ts`                            | Worker + `OpenCodeSandbox` DO + `CodeSandbox` DO + `SandboxRpcApi`   |
| `opencode-sandbox/plugins/cloudflare-sandbox.ts` | OpenCode plugin — starts Cap'n Web WS server on :3001                |
| `opencode-sandbox/cloudflare-sandbox/rpc.ts`     | Plugin-side Cap'n Web session + `getSandbox()` promise               |
| `opencode-sandbox/cloudflare-sandbox/logger.ts`  | Thin logger wrapper used by the plugin                               |
| `opencode-sandbox/tools/bash.ts`                 | `bash` tool — routes `exec` calls through `SandboxRpcApi`            |
| `opencode-sandbox/tools/read.ts`                 | `read` tool — `readFile` via `SandboxRpcApi`                         |
| `opencode-sandbox/tools/write.ts`                | `write` tool — `writeFile` via `SandboxRpcApi`                       |
| `opencode-sandbox/tools/edit.ts`                 | `edit` tool — read + patch + write via `SandboxRpcApi`               |
| `opencode-sandbox/tools/glob.ts`                 | `glob` tool — `exec find` via `SandboxRpcApi`                        |
| `opencode-sandbox/tools/grep.ts`                 | `grep` tool — `exec grep` via `SandboxRpcApi`                        |
| `opencode-sandbox/tools/list.ts`                 | `list` tool — `exec ls` via `SandboxRpcApi`                          |
| `Dockerfile.opencode-sandbox`                    | Image for `OpenCodeSandbox`: sandbox base + opencode CLI + plugin    |
| `Dockerfile.code-sandbox`                        | Image for `CodeSandbox`: sandbox base with matching directory layout |
| `wrangler.jsonc`                                 | Two container DO bindings (`OPENCODE` + `SANDBOX`)                   |
| `worker-configuration.d.ts`                      | Env type declarations                                                |
| `package.json`                                   | Dependencies + build/dev scripts                                     |

## Current State

### Done

- Worker (`src/index.ts`) — `createOpencodeServer` + `proxyToOpencode` + Cap'n Web bridge wiring
- `OpenCodeSandbox` Dockerfile — `cloudflare/sandbox` base + opencode CLI + plugin
- `CodeSandbox` Dockerfile — `cloudflare/sandbox` base, mirrors `/home/user/project` layout
- Sandbox plugin (`plugins/cloudflare-sandbox.ts`) — OpenCode plugin with WebSocket server
- Seven custom tools registered and routing through `SandboxRpcApi`
- Wrangler config — two container DO bindings (`OPENCODE` + `SANDBOX`)
- `SandboxRpcApi` — Cap'n Web `RpcTarget` exposing `sandbox(sessionId)`
- Per-session sandboxes — tools pass `context.sessionID`, API routes to `session-{id}` instances
- Log streaming — `onStart` callback streams `opencode serve` stdout to Worker logs

### Needs verification

- **End-to-end tool calls via UI** — SPA → OpenCode → tool → plugin → Cap'n Web → Worker → CodeSandbox
- **Cold start timing** — First tool call may time out if CodeSandbox isn't warm when OpenCode first calls it

### Future work

- **Sandbox pre-warming** — Listen to OpenCode event stream for `session.created`, pre-warm the
  corresponding `CodeSandbox` instance before the first tool call arrives
- **Production deployment** — Requires a custom domain with wildcard DNS (`*.yourdomain.com`) for
  preview URL routing; `.workers.dev` domains do not support the needed subdomain patterns
- **Clean up logging** — Remove debug `console.log` calls once end-to-end flow is verified

## Key Dependencies

- `@cloudflare/sandbox` — Sandbox SDK (local workspace package)
- `@cloudflare/containers` — `switchPort` utility for port-switching requests inside the DO
- `@opencode-ai/sdk` — OpenCode client SDK and `Config` type
- `capnweb` — Cap'n Web RPC over WebSocket (bridges the DO and the plugin process)

## Dev Notes

- `npm run build` copies CA certificates before `wrangler dev` — required because the container
  proxy intercepts TLS and the CA cert must be baked into the image.
- The plugin is loaded by OpenCode from `.opencode/` inside `/home/user/project` (the workdir).
  The Dockerfile copies `opencode-sandbox/` there directly.
- `OPENAI_API_KEY` must be set in `.dev.vars` (see `.dev.vars.example`).
