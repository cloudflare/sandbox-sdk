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

### Container instance type

The default configuration uses `"lite"` instances with `max_instances: 3`. This is a good starting point for development and light usage. For production workloads that need more CPU or memory, change `instance_type` to `"standard-1"` (4 vCPU / 8 GiB RAM) and increase `max_instances` in `wrangler.jsonc`.

## Updating

The bridge worker depends on two versioned artifacts that should be kept in sync:

1. **`@cloudflare/sandbox`** — the SDK package in `package.json`. Bump the version (or use `"*"` to track latest) and run `npm install`.
2. **`cloudflare/sandbox` Docker image** — the base image tag in `Dockerfile` (e.g. `FROM docker.io/cloudflare/sandbox:0.9.0`). Update the tag to match the SDK version.

Both versions should match — the SDK and container image are released together. After updating:

```sh
npm install
npm run dev          # verify locally
npx wrangler deploy  # deploy the update
```

## Authentication

All `/v1/sandbox/*` and `/v1/openapi.*` routes require:

```
Authorization: Bearer <SANDBOX_API_KEY>
```

If `SANDBOX_API_KEY` is not configured on the worker, auth is skipped — convenient for local dev without a `.dev.vars` file. Set the secret before deploying:

```sh
wrangler secret put SANDBOX_API_KEY
```

## Sandbox Interface

This worker is an HTTP bridge for the `BaseSandboxSession` abstract interface. Each abstract method maps to exactly one route:

| `BaseSandboxSession` method | Route                                 | Description                                      |
| --------------------------- | ------------------------------------- | ------------------------------------------------ |
| _(create session)_          | `POST /v1/sandbox`                    | Generate a new sandbox ID                        |
| `_exec_internal()`          | `POST /v1/sandbox/:id/exec`           | Run a command; returns stdout/stderr/exit_code   |
| `read()`                    | `POST /v1/sandbox/:id/read`           | Read a file from the workspace                   |
| `write()`                   | `POST /v1/sandbox/:id/write`          | Write a file into the workspace                  |
| `running()`                 | `GET /v1/sandbox/:id/running`         | Check sandbox liveness                           |
| `persist_workspace()`       | `POST /v1/sandbox/:id/persist`        | Serialize workspace to a tar archive             |
| `hydrate_workspace()`       | `POST /v1/sandbox/:id/hydrate`        | Populate workspace from a tar archive            |
| `shutdown()`                | `DELETE /v1/sandbox/:id`              | Destroy sandbox via `destroy()` (returns 204)    |
| _(terminal)_                | `GET /v1/sandbox/:id/pty`             | WebSocket PTY proxy (bidirectional terminal I/O) |
| `mountBucket()`             | `POST /v1/sandbox/:id/mount`          | Mount an S3-compatible bucket                    |
| `unmountBucket()`           | `POST /v1/sandbox/:id/unmount`        | Unmount a mounted bucket                         |
| _(create session)_          | `POST /v1/sandbox/:id/session`        | Create an execution session                      |
| _(delete session)_          | `DELETE /v1/sandbox/:id/session/:sid` | Delete an execution session                      |

## API Reference

All examples assume `SANDBOX_API_KEY=your-secret` and the worker running at `http://localhost:8787`.

#### `GET /health`

Unauthenticated liveness probe.

```sh
curl http://localhost:8787/health
```

#### `POST /v1/sandbox`

Create a new sandbox session. Returns a unique sandbox ID.

```sh
curl -X POST http://localhost:8787/v1/sandbox \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{ "id": "mfrggzdfmy2tqnrzgezdgnbv" }
```

---

---

#### `POST /v1/sandbox/:id/exec`

Run a shell command inside the sandbox. Returns base64-encoded stdout/stderr and an exit code.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/exec \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"argv": ["sh", "-lc", "echo hello"], "timeout_ms": 10000, "cwd": "/workspace"}'
```

---

#### `POST /v1/sandbox/:id/read`

Read a file from the sandbox filesystem. Returns raw bytes (`application/octet-stream`).

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/read \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "/workspace/main.py"}'
```

---

#### `POST /v1/sandbox/:id/write`

Write a file into the sandbox filesystem.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/write \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -F "path=/workspace/main.py" \
  -F "file=@main.py"
```

---

#### `GET /v1/sandbox/:id/running`

Check whether the sandbox container is alive.

```sh
curl http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/running \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

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

#### `GET /v1/sandbox/:id/pty`

Open a WebSocket PTY session to the sandbox. The connection is a bidirectional proxy to the container's terminal via `sandbox.terminal()`.

**Query parameters:**

| Param     | Type   | Default | Description                           |
| --------- | ------ | ------- | ------------------------------------- |
| `cols`    | number | 80      | Terminal width in columns             |
| `rows`    | number | 24      | Terminal height in rows               |
| `shell`   | string | —       | Shell binary (e.g. `/bin/bash`)       |
| `session` | string | —       | SDK session ID for session-scoped PTY |

**WebSocket frame protocol:**

| Direction       | Frame type  | Content                                                               |
| --------------- | ----------- | --------------------------------------------------------------------- |
| Client → Server | Binary      | UTF-8 encoded keystrokes / input                                      |
| Server → Client | Binary      | Terminal output (including ANSI escape sequences)                     |
| Client → Server | Text (JSON) | Control messages (e.g. `{"type": "resize", "cols": 120, "rows": 30}`) |
| Server → Client | Text (JSON) | Status messages (`ready`, `exit`, `error`)                            |

The request must include the `Upgrade: websocket` header; plain HTTP requests return `400`.

```sh
# Example using websocat
websocat "ws://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/pty?cols=120&rows=30" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

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

**Request body:**

| Field                                 | Type    | Required | Description                                    |
| ------------------------------------- | ------- | -------- | ---------------------------------------------- |
| `bucket`                              | string  | yes      | Bucket name                                    |
| `mountPath`                           | string  | yes      | Absolute path in the container to mount at     |
| `options.endpoint`                    | string  | yes      | S3-compatible endpoint URL                     |
| `options.readOnly`                    | boolean | no       | Mount as read-only (default: false)            |
| `options.prefix`                      | string  | no       | Subdirectory prefix within the bucket          |
| `options.credentials.accessKeyId`     | string  | no       | Explicit access key (auto-detected if omitted) |
| `options.credentials.secretAccessKey` | string  | no       | Explicit secret key (auto-detected if omitted) |

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

#### `POST /v1/sandbox/:id/session`

Create an execution session. Sessions isolate working directory, environment variables, and command execution state within a sandbox.

```sh
curl -X POST http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/session \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Response:

```json
{ "id": "sess_abc123" }
```

Pass the returned session ID via the `Session-Id` header on subsequent `/exec`, `/pty`, and file operations to scope them to the session.

---

#### `DELETE /v1/sandbox/:id/session/:sid`

Delete an execution session.

```sh
curl -X DELETE http://localhost:8787/v1/sandbox/mfrggzdfmy2tqnrz/session/sess_abc123 \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Returns 204 No Content on success.

---

## Session Support

The bridge supports the Sandbox SDK's session mechanism via the `Session-Id` request header. Sessions isolate command execution contexts (working directory, environment variables) within a single sandbox.

- **Create a session**: `POST /v1/sandbox/:id/session` — returns a session ID.
- **Use a session**: Pass `Session-Id: <session-id>` on `/exec`, `/pty`, and file operation requests.
- **Delete a session**: `DELETE /v1/sandbox/:id/session/:sid` — tears down the session.
- **Default session**: When no `Session-Id` header is provided, requests use the sandbox's default session.

### Session limitations

- **Custom sessions don't survive container sleep.** Only the default session persists across container restarts. Custom sessions are ephemeral — if the container sleeps and restarts, custom sessions are lost.
- **`destroy()` kills in-flight operations immediately.** Deleting a sandbox via `DELETE /v1/sandbox/:id` calls `sandbox.destroy()`, which terminates all running commands and sessions without waiting for completion.
- **Deleted sandbox IDs can be reused.** After destroying a sandbox, the same ID can be used again — it gets a fresh container.

---

See `/v1/openapi.html` in local dev for full request/response schemas.

## Container Warm Pool

The worker includes an optional **warm pool** that pre-starts sandbox containers so new sessions boot instantly. The implementation is adapted from [cf-container-warm-pool](https://github.com/mikenomitch/cf-container-warm-pool).

### How it works

A singleton `WarmPool` Durable Object maintains a set of pre-started containers. When a new sandbox session arrives, it is assigned a container from the pool instead of cold-starting one. Once assigned, a container is consumed and never returned to the pool. An alarm-driven loop continuously health-checks containers and replenishes the pool to the configured target.

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

Stops all idle (unassigned) warm containers. Does not affect containers currently assigned to sandbox sessions.

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

All `/v1/sandbox/*` and `/v1/openapi.*` routes require a Bearer token (`SANDBOX_API_KEY`). When the token is not configured, auth is skipped for local development convenience but a warning is logged. Always set the token before deploying:

```sh
wrangler secret put SANDBOX_API_KEY
```

### Workspace containment

All file operations (`/read`, `/write`) and the `cwd` parameter on `/exec` are validated to resolve within `/workspace`. Paths are POSIX-normalised (`.` and `..` segments resolved) before the prefix check, preventing traversal attacks such as `/workspace/../../etc/passwd`.

The `/persist` and `/hydrate` endpoints always operate on `/workspace` — there is no configurable root parameter. Exclude entries on `/persist` are validated against path traversal and shell-quoted before interpolation into commands.

### Non-root container user

The container image creates a dedicated `sandbox` user. `/workspace` is owned by this user; sensitive directories like `/root` are locked down. This limits what commands executed via `/exec` can access — system files such as `/etc/shadow` are not readable.

### Input validation

- **Sandbox IDs** must match `[a-z2-7]{1,128}` (base32 lowercase).
- **Shell arguments** in `/exec` are single-quote-escaped via `shellQuote()` before being passed to the container shell.
- **Tar payloads** on `/hydrate` are capped at 32 MiB.

### Known limitations

- **Exec runs arbitrary commands.** The `/exec` endpoint does not restrict which programs can be run. The non-root user and filesystem permissions are the primary constraints. Tools like `curl` remain available and could be used to exfiltrate data from the workspace or probe the network.
- **Symlink escape.** Path validation happens at the HTTP layer by normalising path strings. It cannot resolve symlinks, which exist only inside the container. A caller could use `/exec` to create a symlink from `/workspace/link` to a file outside the workspace, then `/read` that symlink. The non-root user mitigates the impact (sensitive root-owned files are inaccessible), but world-readable files like `/etc/passwd` could still be read this way.
- **`USER` directive scope.** The `USER sandbox` directive in the Dockerfile sets the default user for the container entrypoint. Whether `sandbox.exec()` inherits this user depends on the Cloudflare Sandbox runtime behaviour. Verify after deployment that commands run as `sandbox` (e.g. `exec ["whoami"]`).
- **No network restrictions.** There are no egress network controls within the container. If your threat model requires it, consider restricting outbound access at the container or platform level.
