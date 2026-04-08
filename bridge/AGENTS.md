# cloudflare-sandbox-bridge

This is a Cloudflare Worker (TypeScript + Hono) that exposes the sandbox HTTP API. See [README.md](./README.md) for setup, configuration, and API details.

## Key files

- `src/index.ts` — Hono routes, sandbox bridge logic, pool resolution middleware, and WebSocket PTY proxy at `/sandbox/:id/pty`
- `src/warm-pool.ts` — `WarmPool` Durable Object that maintains a pool of pre-started sandbox containers (adapted from [cf-container-warm-pool](https://github.com/mikenomitch/cf-container-warm-pool))
- `src/openapi.ts` — OpenAPI 3.1 schema definition
- `src/openapi-html.ts` — Self-contained HTML renderer for the OpenAPI spec
- `src/__tests__/pty.test.ts` — PTY WebSocket proxy unit tests
- `src/__tests__/warm-pool.test.ts` — WarmPool Durable Object unit tests
- `Dockerfile` — Container image extending `cloudflare/sandbox` with agent tooling
- `script/token` — Generate random `SANDBOX_API_KEY` for `.dev.vars` or Wrangler secrets (`--deploy`)
- `script/deploy` — Full production deploy (deps, auth, secrets, deploy, health-check, summary)
- `wrangler.jsonc` — Worker and Durable Object configuration (Sandbox + WarmPool DOs, `WARM_POOL_TARGET` / `WARM_POOL_REFRESH_INTERVAL` vars)

## Development

```sh
npm ci
npm run dev
```

- Typecheck with `npm run typecheck` (`tsc --noEmit`)
- Deploy with `npm run deploy`

## Completing a feature

When finishing a feature or PR, ensure documentation is up to date:

- **README.md** — Update the route table, API reference section, and any relevant examples.
- **AGENTS.md** — Add new key files and update descriptions if behaviour changed.
- **`src/openapi.ts`** — Add or update endpoint schemas so `/openapi.html` and `/openapi.json` stay accurate.
