# Bridge (SDK internals)

The bridge is the library layer that powers `@cloudflare/sandbox/bridge`. It provides a `bridge()` factory that wraps a user's Worker with sandbox API routes, warm pool management, and authentication — all via Hono.

Consumer-facing documentation (API reference, deployment, security) lives in [`bridge/worker/README.md`](../../../../bridge/worker/README.md).

## Key files

- `index.ts` — `bridge()` factory: resolves DO bindings at module evaluation time, wraps `fetch` and `scheduled` handlers. The capnweb RPC route (`/v1/rpc`) is registered inside `createBridgeApp()` (see `routes.ts`) so it goes through the same dispatch as the rest of the `/v1/*` surface.
- `routes.ts` — `createBridgeApp()`: Hono app containing all `/v1/` API routes (sandbox CRUD, exec, file I/O, persist/hydrate, mount/unmount, session CRUD, pool management, WebSocket PTY proxy, and the experimental capnweb RPC endpoint). Parameterised by binding names and route prefixes.
- `rpc-api.ts` — capnweb RPC layer. Defines `BridgeRPCAPI` (top-level target with one method, `sandbox(id?)`, that allocates a fresh ID when omitted and validates supplied IDs via `isValidSandboxId`) and `SandboxRPCAPI` (the 10 domains: commands/files/processes/ports/git/interpreter/utils/backup/desktop/watch, plus an `id` getter so callers can read back a generated ID). Each domain shim forwards to the SDK's `BridgeSandbox` proxy. Container resolution is direct: `getBridgeSandbox(ns, id)` — no warm-pool indirection. Exports `handleRpcUpgrade(request, env, config)` and `authenticateRpcUpgrade(request, token)` (the subprotocol bearer check, factored out so it can be unit-tested in isolation). The route is gated behind `RouteConfig.enableExperimentalRPC`; when disabled it returns 404.
- `rpc-types.ts` — Wire types: `BridgeRPCAPI`, `SandboxRPCAPI`, and the `BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX` constant. Imported by both the server shim and the `@cloudflare/sandbox/bridge-client` package.
- `bridge-sandbox.ts` — `BridgeSandbox` type (the runtime `Sandbox` class plus the proxy-only `terminal`/`destroy` methods) and `getBridgeSandbox()` factory.
- `warm-pool.ts` — `WarmPool` Durable Object that maintains a pool of pre-started sandbox containers (adapted from [cf-container-warm-pool](https://github.com/mikenomitch/cf-container-warm-pool)).
- `pool.ts` — Pool management helpers used by routes.
- `helpers.ts` — Utility functions (path validation, shell quoting, SSE formatting, `generateSandboxId` / `isValidSandboxId` shared by `routes.ts` and `rpc-api.ts`).
- `types.ts` — `BridgeConfig` (with `apiRoutePrefix`, `healthRoute`, `enableExperimentalRPC`), `BridgeEnv`, `WorkerHandlers` type definitions.
- `openapi.ts` — OpenAPI 3.1 schema definition.
- `openapi-html.ts` — Self-contained HTML renderer for the OpenAPI spec.

## Tests

- HTTP-route tests live in `bridge/worker/src/__tests__/` and import `createBridgeApp` via `bridge-app.ts`.
- Bridge RPC + bridge-client tests live in `packages/sandbox/tests/` (`bridge-rpc.test.ts`, `bridge-client.test.ts`, `bridge-test-helpers.ts`). They drive `handleRpcUpgrade()` directly through an in-process WebSocket pair, plus a small `createBridgeApp()` slice for the experimental-flag gating.
- Integration tests against `wrangler dev` live in `bridge/script/integration`.

## Completing a feature

When finishing a feature or PR that touches bridge internals:

- **`bridge/worker/README.md`** — Update the route table, API reference section, and any relevant examples.
- **This file (AGENTS.md)** — Add new key files and update descriptions if behaviour changed.
- **`openapi.ts`** — Add or update endpoint schemas so `/v1/openapi.html` and `/v1/openapi.json` stay accurate.
- **`@cloudflare/sandbox/bridge-client`** (`packages/sandbox/src/bridge-client/`) — Update the typed RPC client whenever `SandboxRPCAPI` gains methods. The client's lazy proxy forwards everything dynamically, so most additions need no client-side code change — but the type surface in `rpc-types.ts` must stay in sync.
