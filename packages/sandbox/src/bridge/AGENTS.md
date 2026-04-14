# Bridge (SDK internals)

The bridge is the library layer that powers `@cloudflare/sandbox/bridge`. It provides a `bridge()` factory that wraps a user's Worker with sandbox API routes, warm pool management, and authentication — all via Hono.

Consumer-facing documentation (API reference, deployment, security) lives in [`bridge/worker/README.md`](../../../../bridge/worker/README.md).

## Key files

- `index.ts` — `bridge()` factory: resolves DO bindings at module evaluation time, wraps `fetch` and `scheduled` handlers.
- `routes.ts` — `createBridgeApp()`: Hono app containing all `/v1/` API routes (sandbox CRUD, exec, file I/O, persist/hydrate, mount/unmount, session CRUD, pool management, WebSocket PTY proxy). Parameterised by binding names and route prefixes.
- `warm-pool.ts` — `WarmPool` Durable Object that maintains a pool of pre-started sandbox containers (adapted from [cf-container-warm-pool](https://github.com/mikenomitch/cf-container-warm-pool)).
- `pool.ts` — Pool management helpers used by routes.
- `helpers.ts` — Utility functions (path validation, shell quoting, SSE formatting).
- `types.ts` — `BridgeConfig`, `BridgeEnv`, `WorkerHandlers` type definitions.
- `openapi.ts` — OpenAPI 3.1 schema definition.
- `openapi-html.ts` — Self-contained HTML renderer for the OpenAPI spec.

## Tests

Bridge route and unit tests live in `bridge/worker/src/__tests__/`. They import `createBridgeApp` directly from this module via a test adapter (`bridge-app.ts`).

## Completing a feature

When finishing a feature or PR that touches bridge internals:

- **`bridge/worker/README.md`** — Update the route table, API reference section, and any relevant examples.
- **This file (AGENTS.md)** — Add new key files and update descriptions if behaviour changed.
- **`openapi.ts`** — Add or update endpoint schemas so `/v1/openapi.html` and `/v1/openapi.json` stay accurate.
