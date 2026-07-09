# cloudflare-sandbox-bridge

Cloudflare Worker (TypeScript + [Hono](https://hono.dev/)) that exposes the sandbox HTTP API. Creates and manages sandboxed execution environments backed by [Cloudflare Containers](https://developers.cloudflare.com/containers/).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/bridge/worker)

## Prerequisites

- Node.js and npm
- A Cloudflare account with the Containers / Sandbox beta enabled
- Wrangler is included as a dev dependency — `npm ci` is all you need

## Getting Started

```sh
npm ci
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set SANDBOX_API_KEY (generate one with: openssl rand -hex 32)
npm run dev
```

The worker starts at `http://localhost:8787`.

### Development tools

When running locally, a few routes make it easy to explore the API:

- **`GET /v1/openapi.html`** — self-contained browser UI rendered from the OpenAPI spec. Open this in your browser to explore every endpoint interactively. Auth is skipped when `SANDBOX_API_KEY` is not set in `.dev.vars`.
- **`GET /v1/openapi.json`** — machine-readable OpenAPI 3.1 schema. Requires `Authorization: Bearer <token>` when the token is set.
- **`GET /health`** — unauthenticated liveness probe; returns `{"ok": true}`.

## Deployment

The fastest way to deploy is the **Deploy to Cloudflare** button above. It clones this directory into your GitHub account, provisions the Durable Objects and container resources, and deploys via Workers Builds.

To deploy manually:

```sh
npm ci
npx wrangler login
npx wrangler secret put SANDBOX_API_KEY    # paste a token from: openssl rand -hex 32
npx wrangler deploy
```

Verify the deployment:

```sh
curl https://<your-worker>.workers.dev/health
```

Run the bridge integration suite from this directory:

```sh
npm run test:integration
```

Without `BASE_URL`, the suite starts a local Worker with containers disabled and validates routes, authentication, input handling, and OpenAPI metadata. Set `BASE_URL` to a deployed Worker to run the full process, terminal, file, and workspace lifecycle suite against a real container.

### Container instance type

The default configuration uses `"lite"` instances with `max_instances: 3`. This is a good starting point for development and light usage. For production workloads that need more CPU or memory, change `instance_type` to `"standard-1"` (4 vCPU / 8 GiB RAM) and increase `max_instances` in `wrangler.jsonc`.

## Updating

The bridge worker depends on two versioned artifacts that should be kept in sync:

1. **`@cloudflare/sandbox`** — the SDK package in `package.json`. Bump the version (or use `"*"` to track latest) and run `npm install`.
2. **`cloudflare/sandbox` Docker image** — the base image tag in `Dockerfile` (e.g. `FROM docker.io/cloudflare/sandbox:0.12.1`). Update the tag to match the SDK version.

Both versions should match — the SDK and container image are released together. After updating:

```sh
npm install
npm run dev          # verify locally
npx wrangler deploy  # deploy the update
```

## Authentication

All `/v1/sandbox/*`, `/v1/pool/*`, and `/v1/openapi.*` routes require:

```
Authorization: Bearer <SANDBOX_API_KEY>
```

If `SANDBOX_API_KEY` is not configured on the worker, auth is skipped — convenient for local dev without a `.dev.vars` file. Set the secret before deploying:

```sh
wrangler secret put SANDBOX_API_KEY
```

## Sandbox Interface

This worker exposes current Sandbox route domains over HTTP. Process execution is a launch/list/get/log/control API; terminals are separate PTY resources.

| Domain              | Route                                                                                                          | Description                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Sandbox lifecycle   | `POST /v1/sandbox`, `DELETE /v1/sandbox/:id`, `GET /v1/sandbox/:id/running`                                    | Create, destroy, and check a sandbox                    |
| Processes           | `POST /v1/sandbox/:id/processes`                                                                               | Launch an argv process                                  |
| Processes           | `GET /v1/sandbox/:id/processes`                                                                                | List runtime-local process statuses                     |
| Processes           | `GET /v1/sandbox/:id/processes/:processId`                                                                     | Fetch one process status                                |
| Process logs        | `GET /v1/sandbox/:id/processes/:processId/logs`                                                                | Stream SSE log events with cursor replay/follow options |
| Process control     | `POST /v1/sandbox/:id/processes/:processId/kill`                                                               | Send a numeric signal to a process                      |
| Terminals           | `POST /v1/sandbox/:id/terminals`, `GET /v1/sandbox/:id/terminals`, `GET /v1/sandbox/:id/terminals/:terminalId` | Create/list/fetch PTY terminal snapshots                |
| Terminal connection | `GET /v1/sandbox/:id/terminals/:terminalId/connect`                                                            | WebSocket terminal connection/reconnection              |
| Terminal control    | `POST /v1/sandbox/:id/terminals/:terminalId/interrupt`, `POST /v1/sandbox/:id/terminals/:terminalId/terminate` | Control a terminal                                      |
| Files               | `GET /v1/sandbox/:id/file/*`, `PUT /v1/sandbox/:id/file/*`                                                     | Read/write workspace files                              |
| Tunnels             | `POST /v1/sandbox/:id/tunnel/:port`, `DELETE /v1/sandbox/:id/tunnel/:port`                                     | Create/reuse/delete tunnels                             |
| Workspace archives  | `POST /v1/sandbox/:id/persist`, `POST /v1/sandbox/:id/hydrate`                                                 | Persist/hydrate workspace tar archives                  |
| Mounts              | `POST /v1/sandbox/:id/mount`, `POST /v1/sandbox/:id/unmount`                                                   | Mount/unmount S3-compatible buckets                     |

## API Reference

All examples assume `SANDBOX_API_KEY=your-secret` and the worker running at `http://localhost:8787`.

#### `GET /health`

Unauthenticated liveness probe.

```sh
curl http://localhost:8787/health
```

#### `POST /v1/sandbox`

Create a new sandbox. Returns a unique sandbox ID.

```sh
curl -X POST http://localhost:8787/v1/sandbox \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{ "id": "mfrggzdfmy2tqnrzgezdgnbv" }
```

---

#### Process resources

Launch argv directly. Shell syntax requires an explicit shell executable in `argv`. Optional fields are `timeout` (a remote process lifetime deadline in milliseconds), `cwd` (must resolve under `/workspace`), and string-valued `env`.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/processes \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv": ["/bin/bash", "-lc", "echo hello"], "timeout": 10000, "cwd": "/workspace", "env": {"CI": "1"}}'
```

The response confirms launch and contains the current discriminated process status, including the process `id`, required numeric `pid`, `state`, timestamps, and numeric exit information when already available. It does not wait for completion. Launch is the only process route that allocates or wakes a runtime. If the launch timeout is reached, the supervisor may terminate and then kill the process internally, and completion is reported with `timedOut: true`. Use the ID later while the same sandbox runtime remains alive.

```sh
# List processes
curl http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/processes \
  -H "Authorization: Bearer $SANDBOX_API_KEY"

# Fetch one process
curl http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/processes/<process-id> \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

List, fetch, log, and kill routes are lookup-only and do not wake a sandbox with no active runtime; list returns `[]`, while fetch, log, and kill return not found in that case. Process IDs, PIDs, statuses, retained logs, and cursors are runtime-local and cannot be recovered after sleep, restart, or replacement.

Stream logs as Server-Sent Events. Use `replay=true` to include retained output, `follow=true` to keep the stream open for new output, and `since=<cursor>` to resume after a cursor. Each SSE frame is a `data:` JSON object. `stdout` and `stderr` events include base64 `data`, `cursor`, and `timestamp`; lifecycle events include their type/status fields. Closing the SSE connection cancels only that observation and leaves the process running.

```sh
curl -sN "http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/processes/<process-id>/logs?replay=true&follow=true" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Control a process:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/processes/<process-id>/kill \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"signal": 15}'
```

The control route defaults to signal 15 and accepts integer signals from 1 through 64. It returns `204 No Content`. Unknown process IDs return `{ "error": "Process not found", "code": "not_found" }` with 404. A signal request is control intent; final process status and log events remain the observed completion truth.

---

#### `GET /v1/sandbox/:id/file/:path`

Read a file from the sandbox filesystem. The file path is given in the URL after `/file/` as an absolute path without the leading slash (e.g. `workspace/main.py` for `/workspace/main.py`). Must resolve within `/workspace`. Returns raw bytes (`application/octet-stream`).

```sh
curl -X GET http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/file/workspace/main.py \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `PUT /v1/sandbox/:id/file/:path`

Write a file into the sandbox filesystem. The file path is given in the URL after `/file/`, and the file contents are sent as the raw request body.

```sh
curl -X PUT http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/file/workspace/main.py \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @main.py
```

---

#### `GET /v1/sandbox/:id/running`

Check whether the sandbox container is alive.

```sh
curl http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/running \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `POST /v1/sandbox/:id/tunnel/:port`

Create or reuse a tunnel for a service that is already running inside the
sandbox. This may provision tunnel infrastructure, but it does not start the
application listening on the port. Send no body for an ephemeral
`*.trycloudflare.com` tunnel, or pass `name` to choose the subdomain prefix for
a named tunnel, such as `"app"`. Do not pass a full hostname.

Ephemeral tunnel:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/tunnel/8080 \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Named tunnel:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/tunnel/8080 \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "app"}'
```

Response:

```json
{
  "id": "11111111-2222-3333-4444-555555555555",
  "port": 8080,
  "url": "https://app.example.com",
  "hostname": "app.example.com",
  "name": "app",
  "createdAt": "2026-05-29T00:00:00.000Z"
}
```

Named tunnels require `CLOUDFLARE_API_TOKEN`. If the account or zone cannot be
inferred from the token, set `CLOUDFLARE_TUNNEL_ACCOUNT_ID` or
`CLOUDFLARE_ACCOUNT_ID`, and/or set `CLOUDFLARE_ZONE_ID`.

---

#### `DELETE /v1/sandbox/:id/tunnel/:port`

Delete the tunnel for a sandbox port. This stops the tunnel process and removes
any named-tunnel Cloudflare resources tracked by the sandbox.

```sh
curl -X DELETE http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/tunnel/8080 \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Returns `204 No Content` when the tunnel was deleted or already absent.

---

#### `POST /v1/sandbox/:id/persist`

Serialize the sandbox workspace to a tar archive. Returns raw tar bytes.

```sh
curl -X POST "http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/persist?excludes=.venv,__pycache__" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -o workspace.tar
```

---

#### `POST /v1/sandbox/:id/hydrate`

Populate the sandbox workspace from a tar archive.

```sh
curl -X POST "http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/hydrate" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @workspace.tar
```

---

#### Terminal resources

Create a generated terminal resource with `argv`, optional `cwd`/`env`, and optional `cols`/`rows`, then connect to it over WebSocket.

```sh
curl -X POST "http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/terminals" \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv":["bash"],"cols":120,"rows":30}'

websocat "ws://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/terminals/<terminal-id>/connect?cols=120&rows=30" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Use `GET /v1/sandbox/:id/terminals` to list retained terminals and
`GET /v1/sandbox/:id/terminals/:terminalId` to fetch one snapshot. Reconnects
can pass `cursor`, `cols`, and `rows` query parameters. Use terminal `interrupt`
and `terminate` routes to control the PTY resource.

---

#### `DELETE /v1/sandbox/:id`

Destroy the sandbox via `sandbox.destroy()`. Returns 204 No Content on success.

```sh
curl -X DELETE http://localhost:8787/v1/sandbox/my-sandbox \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

---

#### `POST /v1/sandbox/:id/mount`

Mount an S3-compatible bucket (R2, S3, GCS, etc.) as a local directory inside the container.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/mount \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"bucket": "my-bucket", "mountPath": "/mnt/data", "options": {"endpoint": "https://ACCT.r2.cloudflarestorage.com"}}'
```

To mount a Worker R2 binding without credentials, provide the top-level `binding`
field and omit `options.endpoint`:

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/mount \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"binding": "MY_BUCKET", "mountPath": "/mnt/data", "options": {"prefix": "/uploads/"}}'
```

**Request body:**

| Field                                 | Type    | Required | Description                                                                     |
| ------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| `bucket`                              | string  | no       | Remote bucket name for endpoint-based S3-compatible mounts                      |
| `binding`                             | string  | no       | Worker R2 binding name for credential-less R2 binding mounts                    |
| `mountPath`                           | string  | yes      | Absolute path in the container to mount at                                      |
| `options.endpoint`                    | string  | no       | S3-compatible endpoint URL for remote mounts; mutually exclusive with `binding` |
| `options.readOnly`                    | boolean | no       | Mount as read-only (default: false)                                             |
| `options.prefix`                      | string  | no       | Subdirectory prefix within the bucket                                           |
| `options.credentials.accessKeyId`     | string  | no       | Explicit access key (auto-detected if omitted)                                  |
| `options.credentials.secretAccessKey` | string  | no       | Explicit secret key (auto-detected if omitted)                                  |
| `options.credentialProxy`             | boolean | no       | Keep credentials in the Durable Object and sign intercepted s3fs requests       |

Credentials are optional — the SDK auto-detects from Worker secrets (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).

---

#### `POST /v1/sandbox/:id/unmount`

Unmount a previously mounted bucket.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/unmount \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mountPath": "/mnt/data"}'
```

---

See `/v1/openapi.html` in local dev for full request/response schemas.

## Container Warm Pool

The worker includes an optional **warm pool** that pre-starts sandbox containers so new sandboxes boot instantly.

### How it works

A singleton `WarmPool` Durable Object maintains a set of pre-started containers. When a new sandbox arrives, it is assigned a container from the pool instead of cold-starting one. Once assigned, a container is consumed and never returned to the pool. An alarm-driven loop continuously health-checks containers and replenishes the pool to the configured target.

The pool is primed (its alarm loop started) in two ways:

1. **Cron trigger** — a `* * * * *` (every-minute) cron is configured in `wrangler.jsonc`. On each tick the `scheduled()` handler calls `configure()` on the `WarmPool` DO, which starts the alarm loop. This ensures the pool is active immediately after deploy, even with no HTTP traffic.
2. **`POST /v1/pool/prime`** — an explicit HTTP route that does the same thing. Useful for manual priming or CI/CD scripts.

### Configuration

Set these variables in `wrangler.jsonc` (under `vars`) or via `wrangler secret put`:

| Variable                     | Default   | Description                                                                          |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `WARM_POOL_TARGET`           | `"0"`     | Number of idle containers to keep warm. **0 disables the pool** (no surprise bills). |
| `WARM_POOL_REFRESH_INTERVAL` | `"10000"` | Milliseconds between pool health-check / replenishment cycles.                       |

The cron trigger frequency can be adjusted in `wrangler.jsonc` under `triggers.crons`. Remove the cron entirely if you only want manual priming via `POST /v1/pool/prime`.

### Pool management routes

These routes require the same `Authorization: Bearer <SANDBOX_API_KEY>` as sandbox routes.

#### `GET /v1/pool/stats`

Returns current pool statistics.

```sh
curl http://localhost:8787/v1/pool/stats \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{
  "warm": 3,
  "assigned": 2,
  "total": 5,
  "config": { "warmTarget": 3, "refreshInterval": 10000 },
  "maxInstances": 10
}
```

#### `POST /v1/pool/shutdown-prewarmed`

Stops all idle (unassigned) warm containers. Does not affect containers currently assigned to sandboxes.

```sh
curl -X POST http://localhost:8787/v1/pool/shutdown-prewarmed \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

#### `POST /v1/pool/prime`

Primes the warm pool by pushing the current configuration and starting the alarm loop. Called automatically by the cron trigger; can also be called manually.

```sh
curl -X POST http://localhost:8787/v1/pool/prime \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

## Container Image

`./Dockerfile` extends `docker.io/cloudflare/sandbox` and pre-installs the tools agents commonly use:

- `git` — version control
- `ripgrep` (`rg`) — fast text and file search
- `curl`, `wget` — HTTP fetching
- `jq` — JSON processing
- `procps` — process management (`ps`, `pkill`)
- `sed`, `gawk` — text processing

Extend the `Dockerfile` to add languages or tools needed for your workloads (e.g. `python3`, `nodejs`, `npm`).

## Security

The worker applies multiple layers of security to constrain operations within the sandbox:

### Authentication

All `/v1/sandbox/*`, `/v1/pool/*`, and `/v1/openapi.*` routes require a Bearer token (`SANDBOX_API_KEY`). When the token is not configured, auth is skipped for local development convenience but a warning is logged. Always set the token before deploying:

```sh
wrangler secret put SANDBOX_API_KEY
```

### Workspace containment

All file operations (`/file/*`) and process `cwd` parameters are validated to resolve within `/workspace`. Paths are POSIX-normalised (`.` and `..` segments resolved) before the prefix check, preventing traversal attacks such as `/workspace/../../etc/passwd`.

Terminal creation currently validates `cwd` as a string but does not workspace-confine it before forwarding to the container runtime. The terminal `argv` must still be a non-empty string array.

The `/persist` and `/hydrate` endpoints always operate on `/workspace` — there is no configurable root parameter. Exclude entries on `/persist` are validated against path traversal and shell-quoted before interpolation into commands.

### Non-root container user

The container image creates a dedicated `sandbox` user. `/workspace` is owned by this user; sensitive directories like `/root` are locked down. This limits what launched processes can access — system files such as `/etc/shadow` are not readable.

### Input validation

- **Sandbox IDs** must match `[a-z2-7]{1,128}` (base32 lowercase).
- **Process and terminal argv** must be non-empty string arrays; shell syntax is available only when the caller explicitly launches a shell in `argv`.
- **Tar payloads** on `/hydrate` are capped at 32 MiB.

### Known limitations

- **Processes run arbitrary executables.** The process launch route does not restrict which programs can be run. The non-root user and filesystem permissions are the primary constraints. Tools like `curl` remain available and could be used to exfiltrate data from the workspace or probe the network.
- **Symlink escape.** Path validation happens at the HTTP layer by normalising path strings. It cannot resolve symlinks, which exist only inside the container. A caller could launch a process to create a symlink from `/workspace/link` to a file outside the workspace, then read that symlink via `/file/*`. The non-root user mitigates the impact (sensitive root-owned files are inaccessible), but world-readable files like `/etc/passwd` could still be read this way.
- **`USER` directive scope.** The `USER sandbox` directive in the Dockerfile sets the default user for the container entrypoint. Whether `sandbox.exec()` inherits this user depends on the Cloudflare Sandbox runtime behaviour. Verify after deployment that commands run as `sandbox` (e.g. launch `argv: ["whoami"]`).
- **No network restrictions.** There are no egress network controls within the container. If your threat model requires it, consider restricting outbound access at the container or platform level.
