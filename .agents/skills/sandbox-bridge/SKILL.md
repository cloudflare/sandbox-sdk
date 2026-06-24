---
name: sandbox-bridge
description: Use when you need to exercise a real, running Sandbox deployment via HTTP — for example to validate SDK changes against a live container, reproduce a user-reported issue, or experiment with the API (including FUSE bucket mounts) without spinning up `wrangler dev`. Documents the Sandbox bridge worker reachable via `SANDBOX_WORKER_URL` + `SANDBOX_API_KEY` when the host injects them.
---

# Sandbox Bridge

A hosted Cloudflare Sandbox deployment _may_ be available to agents working in this repo, depending on whether the host injects credentials for it. It exposes the full `@cloudflare/sandbox` SDK over a small HTTP API ("the bridge") so you can drive a real sandbox container from `curl`, scripts, or tests without deploying your own worker.

The source for the bridge lives in the repo:

- `bridge/worker/` — the deployed worker entrypoint (thin wrapper).
- `packages/sandbox/src/bridge/` — the actual bridge implementation: routes, auth, pool management.

If the API behaves unexpectedly, read those before guessing.

## Credentials

When the host provides them, two environment variables are set in your shell:

| Variable             | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `SANDBOX_WORKER_URL` | Base URL of the bridge worker (https).   |
| `SANDBOX_API_KEY`    | Bearer token for `Authorization` header. |

If either is unset, the bridge isn't available for this session — fall back to `wrangler dev` against an example, or ask the user to enable it.

All requests require `Authorization: Bearer $SANDBOX_API_KEY`. Missing/invalid tokens return `401 unauthorized`. **Always pass the token via the header — never via a query string — to keep it out of access logs and shell history.**

## OpenAPI Spec

The full, authoritative spec is served by the bridge itself:

```bash
curl -sf -H "Authorization: Bearer $SANDBOX_API_KEY" \
  "$SANDBOX_WORKER_URL/v1/openapi.json" | jq '.paths | keys'
```

## Typical Flow

The bridge is stateless from the client's point of view: each sandbox is identified by an opaque ID returned from `POST /v1/sandbox`. Use that ID for every subsequent `/v1/sandbox/{id}/*` call, then `DELETE` it when done.

### 1. Create a sandbox

```bash
SID=$(curl -s -X POST "$SANDBOX_WORKER_URL/v1/sandbox" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" | jq -r .id)
echo "$SID"   # e.g. nmghbg45psadoawxuazxrfr23e
```

### 2. Exec a command (SSE stream)

`POST /v1/sandbox/{id}/exec` streams output as Server-Sent Events. The body takes an `argv` array — already shell-split — so wrap shell snippets in `["sh","-lc", "..."]`.

```bash
curl -sN -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv":["sh","-lc","echo hello; uname -a"]}'
```

Events emitted:

| Event    | `data` payload                        | Notes                           |
| -------- | ------------------------------------- | ------------------------------- |
| `stdout` | base64-encoded chunk of stdout        | May fire many times.            |
| `stderr` | base64-encoded chunk of stderr        | May fire many times.            |
| `exit`   | `{"exit_code": N}` (JSON)             | Terminal — stream closes after. |
| `error`  | `{"error":"...","code":"..."}` (JSON) | Terminal — replaces `exit`.     |

Decode stdout/stderr with `base64 -d`. Optional request fields: `timeout_ms` (per-call timeout) and `cwd` (must resolve under `/workspace`).

A small helper to print decoded stdout:

```bash
curl -sN -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv":["sh","-lc","ls /workspace"]}' \
| awk '/^event: /{ev=$2} /^data: /{sub(/^data: /,""); if(ev=="stdout") print | "base64 -d"; else if(ev=="exit"||ev=="error") print "[" ev "] " $0}'
```

### 3. Read / write files

Files live under `/workspace` inside the sandbox. The path in the URL is given **without** the leading slash and must resolve within `/workspace`.

```bash
# Write
echo 'print("hi")' | curl -s -X PUT \
  "$SANDBOX_WORKER_URL/v1/sandbox/$SID/file/workspace/main.py" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @-

# Read
curl -s -X GET \
  "$SANDBOX_WORKER_URL/v1/sandbox/$SID/file/workspace/main.py" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

### 4. Destroy

Always clean up. Destroying an unknown ID is a no-op (`204`).

```bash
curl -s -X DELETE "$SANDBOX_WORKER_URL/v1/sandbox/$SID" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" -w "%{http_code}\n"
```

## Sessions

The bridge does not use the SDK's default shell session for headerless command and file requests. If you omit `Session-Id`, those requests run without reusing shell state. Create an explicit session when you need state to persist across commands. Sessions isolate two things across commands:

- **Working directory** — `cd` in one exec persists for subsequent execs in the same session.
- **Environment variables** — `export FOO=bar` likewise persists, and `env` passed at session creation seeds the session.

Use named sessions when you need persistent or parallel execution contexts in the same sandbox (for example, a long-running build in one and quick probes in another) without them clobbering each other's `cwd` or environment.

### Create a session

```bash
SESS=$(curl -s -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/session" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cwd":"/workspace","env":{"NODE_ENV":"test"}}' | jq -r .id)
```

The body is optional. You can also pass `id` to choose your own (must match `^[a-zA-Z0-9._-]{1,128}$`); otherwise one is generated for you.

### Use a session

Pass the ID via the `Session-Id` header on `exec`, file read/write, or `pty`:

```bash
curl -sN -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Session-Id: $SESS" \
  -H "Content-Type: application/json" \
  -d '{"argv":["sh","-lc","cd src && pwd && echo $NODE_ENV"]}'

# A second exec in the same session inherits cwd=/workspace/src and NODE_ENV=test:
curl -sN -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Session-Id: $SESS" \
  -H "Content-Type: application/json" \
  -d '{"argv":["sh","-lc","pwd"]}'
```

Invalid session IDs return `400 invalid_request`. Unknown but well-formed IDs are created on first use by some routes — prefer explicit `POST /session` so you control `cwd`/`env`.

### Delete a session

```bash
curl -s -X DELETE "$SANDBOX_WORKER_URL/v1/sandbox/$SID/session/$SESS" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Sessions disappear when the parent sandbox is destroyed.

## Other Endpoints

These exist on the bridge — consult `/v1/openapi.json` for full schemas before using them:

| Path                                        | Purpose                                         |
| ------------------------------------------- | ----------------------------------------------- |
| `/health`                                   | Liveness probe.                                 |
| `/v1/pool/{prime,stats,shutdown-prewarmed}` | Pre-warm pool management.                       |
| `/v1/sandbox/{id}/pty`                      | Interactive PTY stream.                         |
| `/v1/sandbox/{id}/running`                  | List running processes.                         |
| `/v1/sandbox/{id}/{mount,unmount}`          | Mount / unmount S3-compatible buckets via FUSE. |
| `/v1/sandbox/{id}/{hydrate,persist}`        | Workspace persistence ops.                      |

## Error Codes

Errors return JSON `{ "error": "...", "code": "..." }` with one of:
`unauthorized`, `invalid_request`, `exec_error`, `exec_transport_error`,
`workspace_read_not_found`, `workspace_archive_read_error`,
`workspace_archive_write_error`, `capacity_exceeded`, `pool_error`,
`mount_error`, `unmount_error`, `session_error`.

Once an `exec` SSE stream is open, transport errors arrive as `event: error` instead of an HTTP error.

## When to Use This vs. `wrangler dev`

- **Bridge** — fastest path to "does this command behave correctly inside a real sandbox container?". No local Docker, no build step. Also the only option for features that depend on host-level capabilities the local dev loop doesn't replicate, notably **FUSE-based bucket mounts** (`/v1/sandbox/{id}/mount`) — `wrangler dev` cannot mount s3fs-FUSE filesystems.
- **`wrangler dev`** (see the `examples` skill) — required when iterating on the container image, the worker code, or anything that isn't already deployed to the bridge.

The bridge runs whatever version of `@cloudflare/sandbox` is currently deployed to it; it is **not** automatically updated from your working tree. If you need to test unreleased SDK changes that don't require FUSE, use `wrangler dev` against a local example instead.
