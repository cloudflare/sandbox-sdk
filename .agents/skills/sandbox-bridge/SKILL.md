---
name: sandbox-bridge
description: Trigger only when exercising a real running Sandbox deployment over HTTP via SANDBOX_WORKER_URL and SANDBOX_API_KEY, including process, terminal, file, tunnel, mount, pool, or OpenAPI bridge routes.
---

# Sandbox Bridge

A hosted Cloudflare Sandbox deployment may be available when the host injects `SANDBOX_WORKER_URL` and `SANDBOX_API_KEY`. It exposes the current `@cloudflare/sandbox` API over HTTP so agents can validate behavior in a real container without deploying their own Worker.

Source of truth:

- `bridge/worker/README.md` — deployable worker docs and examples.
- `packages/sandbox/src/bridge/routes/*.ts` — route behavior.
- `packages/sandbox/src/bridge/openapi*.ts` — OpenAPI schema served by the bridge.

## Credentials

```bash
: "${SANDBOX_WORKER_URL:?missing bridge URL}"
: "${SANDBOX_API_KEY:?missing bridge token}"
```

Pass `Authorization: Bearer $SANDBOX_API_KEY` on every `/v1/sandbox/*`, `/v1/pool/*`, and `/v1/openapi.*` request. Never put the token in a query string.

Inspect the live schema before using unfamiliar routes:

```bash
curl -sf -H "Authorization: Bearer $SANDBOX_API_KEY" \
  "$SANDBOX_WORKER_URL/v1/openapi.json" | jq '.paths | keys'
```

## Typical process flow

Create a sandbox:

```bash
SID=$(curl -sf -X POST "$SANDBOX_WORKER_URL/v1/sandbox" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" | jq -r .id)
```

Launch argv directly. Use explicit shell argv for shell syntax. Request fields are `argv` (required non-empty string array), optional `timeout` as a remote process lifetime deadline in milliseconds, optional `cwd` under `/workspace`, and optional string-valued `env`.

```bash
PROC=$(curl -sf -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/processes" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv":["/bin/bash","-lc","echo hello; uname -a"],"cwd":"/workspace","timeout":10000}')
PID=$(printf '%s' "$PROC" | jq -r .id)
```

Launch, list, and fetch responses are `ProcessStatus` objects with `id`, required numeric `pid`, discriminating `state`, timestamps, and exit/error details when complete.

Final process route semantics:

- `POST /v1/sandbox/{id}/processes` launches argv and is the only process route that allocates or wakes a runtime; launch alone creates the process.
- The launch `timeout` field is a remote process lifetime deadline. The supervisor may TERM-to-KILL internally, and completion is reported with `timedOut: true`.
- List, fetch, log, and kill routes are lookup-only and non-waking. With no current runtime, list returns `[]`; fetch, log, and kill return route-appropriate `404` responses.
- Process IDs are runtime-local. After sleep, restart, or replacement, saved IDs and handles are stale and never target the replacement runtime.
- Canceling or disconnecting a logs SSE request only cancels that caller's observation subscription; it does not stop the process.

List or fetch process statuses while the runtime is alive:

```bash
curl -sf "$SANDBOX_WORKER_URL/v1/sandbox/$SID/processes" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"

curl -sf "$SANDBOX_WORKER_URL/v1/sandbox/$SID/processes/$PID" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Stream logs with Server-Sent Events:

```bash
curl -sN "$SANDBOX_WORKER_URL/v1/sandbox/$SID/processes/$PID/logs?replay=true&follow=true" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Log route query fields:

| Query               | Meaning                                     |
| ------------------- | ------------------------------------------- |
| `replay=true` / `1` | Include retained output.                    |
| `follow=true` / `1` | Keep the SSE stream open for future output. |
| `since=<cursor>`    | Resume after a previously returned cursor.  |

Each SSE frame is `data: <json>`. `stdout`/`stderr` objects include `type`, `cursor`, `timestamp`, and base64 `data`. Other lifecycle objects are passed through as JSON. Decode bytes after parsing the JSON, not by treating the whole stream as text output.

Kill a process:

```bash
curl -sf -X POST "$SANDBOX_WORKER_URL/v1/sandbox/$SID/processes/$PID/kill" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"signal":15}'
```

The kill route accepts an optional integer `signal` from 1 through 64, defaults to 15, and returns `204 No Content`.

## Terminal routes

Terminals are PTY resources, not process log streams. Create with `argv` plus optional `cwd`, `env`, `cols`, and `rows`; list/fetch snapshots by ID; connect over WebSocket with optional `cursor`, `cols`, and `rows` query parameters.

| Route                                                    | Purpose                      |
| -------------------------------------------------------- | ---------------------------- |
| `POST /v1/sandbox/{id}/terminals`                        | Create a terminal.           |
| `GET /v1/sandbox/{id}/terminals`                         | List terminal snapshots.     |
| `GET /v1/sandbox/{id}/terminals/{terminalId}`            | Fetch one snapshot.          |
| `GET /v1/sandbox/{id}/terminals/{terminalId}/connect`    | WebSocket connect/reconnect. |
| `POST /v1/sandbox/{id}/terminals/{terminalId}/interrupt` | Send interrupt.              |
| `POST /v1/sandbox/{id}/terminals/{terminalId}/terminate` | Terminate the terminal.      |

## Files, tunnels, mounts, lifecycle, and pool

Common routes:

| Route                                                            | Purpose                           |
| ---------------------------------------------------------------- | --------------------------------- |
| `GET /health`                                                    | Unauthenticated liveness probe.   |
| `GET /v1/sandbox/{id}/running`                                   | Check sandbox liveness.           |
| `GET/PUT /v1/sandbox/{id}/file/*`                                | Read/write workspace files.       |
| `POST/DELETE /v1/sandbox/{id}/tunnel/{port}`                     | Create/reuse/delete tunnels.      |
| `POST /v1/sandbox/{id}/persist`, `POST /v1/sandbox/{id}/hydrate` | Workspace tar archive operations. |
| `POST /v1/sandbox/{id}/mount`, `POST /v1/sandbox/{id}/unmount`   | S3-compatible bucket mounts.      |
| `DELETE /v1/sandbox/{id}`                                        | Destroy a sandbox.                |
| `POST /v1/pool/prime`                                            | Prime the warm pool.              |
| `GET /v1/pool/stats`                                             | Read warm pool statistics.        |
| `POST /v1/pool/shutdown-prewarmed`                               | Shut down prewarmed sandboxes.    |

## Errors

HTTP errors return JSON `{ "error": string, "code": string }`. Common codes include `unauthorized`, `invalid_request`, `not_found`, `process_error`, `exec_transport_error`, `workspace_read_not_found`, `workspace_archive_read_error`, `workspace_archive_write_error`, `capacity_exceeded`, `pool_error`, `mount_error`, `unmount_error`, and `tunnel_error`.

A log SSE stream reports lifecycle/error objects as `data:` JSON frames once the HTTP stream is open.

## Bridge vs wrangler dev

Use the bridge for fast validation against a deployed real container and for host-dependent features such as FUSE mounts. Use `wrangler dev` when changing Worker code, SDK source, the container image, or unreleased behavior not deployed to the bridge.
