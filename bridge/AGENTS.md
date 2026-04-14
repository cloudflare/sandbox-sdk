# cloudflare-sandbox-bridge

This directory contains a deployable Cloudflare Worker that uses `@cloudflare/sandbox/bridge` to expose the sandbox HTTP API. It is a thin wrapper — all route handling, authentication, pool management, and OpenAPI serving are provided by the SDK.

See [`worker/README.md`](./worker/README.md) for the full API reference, deployment guide, and configuration options.

## Key files

- `worker/src/index.ts` — Worker entrypoint: imports `bridge()` from `@cloudflare/sandbox/bridge`, re-exports `Sandbox` and `WarmPool` DOs, and defines optional application-specific `fetch`/`scheduled` handlers.
- `worker/Dockerfile` — Container image extending `cloudflare/sandbox` with agent tooling (git, ripgrep, curl, jq, etc.).
- `worker/wrangler.jsonc` — Worker and Durable Object configuration (Sandbox + WarmPool DOs, warm pool vars).
- `worker/script/token` — Generate a random `SANDBOX_API_KEY`.
- `worker/script/deploy` — Full production deploy script.

## Development

```sh
cd worker
npm ci
npm run dev
```

## Bridge internals

Route logic, warm pool implementation, and OpenAPI schema live in `packages/sandbox/src/bridge/`. See the [bridge AGENTS.md](../packages/sandbox/src/bridge/AGENTS.md) there for contributor guidance.
