---
name: sandbox-bridge
description: "Use when validating SDK changes against a live container, reproducing user-reported issues, or experimenting with the Sandbox API (including FUSE bucket mounts) without wrangler dev. Drives a real sandbox via curl using SANDBOX_WORKER_URL and SANDBOX_API_KEY."
---

# Sandbox Bridge

A hosted Sandbox deployment may be available when the host injects `SANDBOX_WORKER_URL` and `SANDBOX_API_KEY` into the shell. It exposes the full `@cloudflare/sandbox` SDK over HTTP so you can drive a real container from `curl` or scripts.

Source: `bridge/worker/` (worker entrypoint), `packages/sandbox/src/bridge/` (implementation: routes, auth, pool management). Read these if the API behaves unexpectedly.

## Credentials

| Variable             | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `SANDBOX_WORKER_URL` | Base URL of the bridge worker (https).   |
| `SANDBOX_API_KEY`    | Bearer token for `Authorization` header. |

If either is unset, fall back to `wrangler dev` (see the `examples` skill). Always pass the token via the header, never a query string. Missing/invalid tokens return `401`.

## Typical Flow

### 1. Create a sandbox

```bash
SID=$(curl -sf -X POST "$SANDBOX_WORKER_URL/v1/sandbox" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" | jq -r .id)
# Verify creation succeeded before continuing
[ -n "$SID" ] && echo "Created: $SID" || echo "FAILED"
```

### 2. Exec a command (SSE stream)

`POST /v1/sandbox/{id}/exec` streams SSE. Body takes `argv` (already shell-split), optional `timeout_ms` and `cwd` (must resolve under `/workspace`).

```bash
curl -sN -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv":["sh","-lc","echo hello"]}'
```

SSE events: `stdout`/`stderr` (base64-encoded), `exit` (`{"exit_code": N}`, terminal), `error` (terminal, replaces `exit`). Decode with `base64 -d`.

### 3. Read / write files

Paths are relative to root, must resolve within `/workspace`.

```bash
# Write
echo 'print("hi")' | curl -sf -X PUT \
  "$SANDBOX_WORKER_URL/v1/sandbox/$SID/file/workspace/main.py" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/octet-stream" --data-binary @-

# Read
curl -sf "$SANDBOX_WORKER_URL/v1/sandbox/$SID/file/workspace/main.py" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

### 4. Destroy

Always clean up. Destroying an unknown ID is a no-op (`204`).

```bash
curl -sf -X DELETE "$SANDBOX_WORKER_URL/v1/sandbox/$SID" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" -w "%{http_code}\n"
```

## Sessions

The default session backs all calls when no `Session-Id` header is set. Sessions isolate `cwd` and env vars across commands. Use named sessions for parallel execution contexts.

```bash
# Create
SESS=$(curl -sf -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/session" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cwd":"/workspace","env":{"NODE_ENV":"test"}}' | jq -r .id)

# Use — pass Session-Id header on exec, file, or pty calls
curl -sN -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/exec" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Session-Id: $SESS" \
  -H "Content-Type: application/json" \
  -d '{"argv":["sh","-lc","pwd"]}'

# Delete (default session cannot be deleted)
curl -sf -X DELETE "$SANDBOX_WORKER_URL/v1/sandbox/$SID/session/$SESS" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

## Other Endpoints

Consult `$SANDBOX_WORKER_URL/v1/openapi.json` for full schemas. Key routes: `/health`, `/v1/pool/{prime,stats}`, `/v1/sandbox/{id}/pty`, `/v1/sandbox/{id}/running`, `/v1/sandbox/{id}/{mount,unmount}` (FUSE), `/v1/sandbox/{id}/{hydrate,persist}`.

## Error Codes

JSON `{ "error": "...", "code": "..." }` with codes: `unauthorized`, `invalid_request`, `exec_error`, `exec_transport_error`, `workspace_read_not_found`, `workspace_archive_read_error`, `workspace_archive_write_error`, `capacity_exceeded`, `pool_error`, `mount_error`, `unmount_error`, `session_error`. Inside an SSE stream, errors arrive as `event: error`.

## Bridge vs. `wrangler dev`

- **Bridge** — fastest path to test real container behavior. Required for FUSE bucket mounts. Runs the currently deployed SDK version, not your working tree.
- **`wrangler dev`** — required when iterating on the container image, worker code, or unreleased SDK changes.
