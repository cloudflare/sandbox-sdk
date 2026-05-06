---
name: architecture
description: "Use when navigating the project structure, adding a new client method or container handler, tracing request flow from Worker through Sandbox DO into the container, or asking how the code is organized. Shows where to add REST endpoints, wire client SDK methods, register DO handlers, and trace HTTP requests through the Worker-to-container pipeline. (project)"
---

# Architecture

## Three-Layer Architecture

Only `@cloudflare/sandbox` is published to npm. The other two packages are internal.

1. **`@cloudflare/sandbox` (`packages/sandbox/`)** — Public SDK
   - `Sandbox` class: Durable Object managing container lifecycle
   - Modular clients: `CommandClient`, `FileClient`, `ProcessClient`, `PortClient`, `GitClient`, etc.
   - `CodeInterpreter`: high-level API for Python/JS with structured outputs
   - `proxyToSandbox()`: preview URL routing

2. **`@repo/shared` (`packages/shared/`)** — Shared types, error classes (`src/errors/`), logging

3. **`@repo/sandbox-container` (`packages/sandbox-container/`)** — Bun-based container runtime
   - DI container in `core/container.ts`, route handlers, services, managers
   - Bundled into the Docker image

## Request Flow

Primary control path:

```
Worker
  → Sandbox DO (packages/sandbox)
    → ContainerControlClient (packages/sandbox/src/container-control/)
      → capnweb over /rpc WebSocket
        → SandboxControlAPI (packages/sandbox-container/src/control-plane/)
          → container services
            → Shell commands / filesystem
```

Route-based compatibility path:

```
Worker
  → Sandbox DO (packages/sandbox)
    → SandboxClient / clients/transport
      → Container HTTP API on port 3000 (packages/sandbox-container)
        → Router / handlers
          → container services
            → Shell commands / filesystem
```

Errors flow back the same path: container → Sandbox DO → Worker, using the custom error classes in `packages/shared/src/errors/` keyed by the `ErrorCode` enum.

## Primary Control Path

- SDK side: `packages/sandbox/src/container-control/`
- Container side: `packages/sandbox-container/src/control-plane/`
- Wire: capnweb RPC over `/rpc` WebSocket (treat as implementation detail, not architectural boundary)
- Contract: `SandboxAPI` interface in `@repo/shared`

New control-plane capabilities go in this path.

## Route-Based Compatibility Path (`packages/sandbox/src/clients/`)

`packages/sandbox/src/clients/` and `clients/transport/` implement the HTTP/WebSocket compatibility API. Maintain for compatibility and debugging, but do not add new control-plane capabilities here.

Pattern: `BaseHttpClient` (abstract) -> specialized clients (`CommandClient`, `FileClient`, `ProcessClient`, `PortClient`, `GitClient`, `UtilityClient`, `InterpreterClient`) -> aggregated by `SandboxClient`.

## Container Runtime (`packages/sandbox-container/src/`)

- **DI container** (`core/container.ts`) — wires services and manages their lifecycle
- **Router** — HTTP router with middleware
- **Control plane** (`control-plane/`) — primary container-side API called by the Sandbox DO
- **Handlers** (`handlers/`) — route-based compatibility handlers, thin layer that parses requests
- **Services** (`services/`) — business logic (`CommandService`, `FileService`, `ProcessService`, …)
- **Managers** (`managers/`) — stateful coordinators (`ProcessManager`, `PortManager`)

Entry point: `packages/sandbox-container/src/index.ts` starts a Bun HTTP server on port 3000.

When adding a new container control operation:

1. Add/extend a service in `services/` for the business logic.
2. Add the control-plane method in `packages/sandbox-container/src/control-plane/`. Run `npm test -w @repo/sandbox-container` to verify.
3. Mirror the call in `packages/sandbox/src/container-control/`. Run `npm run check` to confirm the RPC contract matches both sides.
4. Add unit tests on both sides; add an E2E test if it touches real shell/filesystem behavior. Run `npm test` then `npm run test:e2e` if applicable.

Only add a route handler in `handlers/` and a route-based SDK client in `packages/sandbox/src/clients/` when maintaining HTTP/WebSocket compatibility.

## Monorepo Structure

- `packages/sandbox` — main SDK package (published)
- `packages/shared` — shared types and utilities (internal)
- `packages/sandbox-container` — container runtime (internal, bundled into image)
- `examples/` — working example projects
- `tooling/` — shared TypeScript configs

Uses npm workspaces + Turbo (`turbo.json` orchestrates dependency-aware builds).

## Cross-Cutting Patterns

- **Sessions** — isolate execution contexts (cwd, env vars). Default auto-created; multiple per sandbox supported. See `session-execution` skill for implementation details.
- **Ports** — expose internal services via preview URLs with token auth. Auto-cleaned on sandbox sleep. Production requires wildcard DNS (`*.yourdomain.com`); `.workers.dev` does not support the required subdomain patterns.
- **Container isolation** — handled at the Cloudflare platform level (VMs), not by SDK code.
- **Container image** — see `packages/sandbox/Dockerfile`. Pin versions, clean caches to minimize cold start.
