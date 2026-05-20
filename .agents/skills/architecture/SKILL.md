---
name: architecture
description: Use when navigating the codebase for the first time, adding a new client method, adding a new container handler/service, or understanding how a request flows from Worker through the Sandbox DO into the container. Covers the three-layer architecture, client pattern, container runtime structure, and monorepo layout. (project)
---

# Architecture

## Three-Layer Architecture

1. **`@cloudflare/sandbox` (`packages/sandbox/`)** — Public SDK published to npm
   - `Sandbox` class: Durable Object that manages the container lifecycle
   - Modular HTTP clients per capability (`CommandClient`, `FileClient`, `ProcessClient`, …)
   - `CodeInterpreter`: high-level API for Python/JS with structured outputs
   - `proxyToSandbox()`: request handler for preview URL routing

2. **`@repo/shared` (`packages/shared/`)** — Internal shared utilities
   - Type definitions used by both SDK and container runtime
   - Centralized error classes (`packages/shared/src/errors/`) and logging
   - **Not published to npm**

3. **`@repo/sandbox-container` (`packages/sandbox-container/`)** — Container runtime
   - Bun-based HTTP server running inside the Docker container
   - Dependency-injection container in `core/container.ts`
   - Route handlers for command execution, file operations, process management
   - **Not published to npm** (bundled into the Docker image)

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

The primary Sandbox Durable Object to container control path is the container-control/control-plane path:

- SDK side: `packages/sandbox/src/container-control/`
- Container side: `packages/sandbox-container/src/control-plane/`
- Current wire implementation: capnweb RPC over the `/rpc` WebSocket route

Control-channel/transport-layer capabilities belong in this path. Treat capnweb/RPC as the current implementation detail, not the architectural boundary.

The shared `@repo/shared` `SandboxAPI` interface remains named `SandboxAPI` because it defines the current control API contract used by both sides.

## Route-Based Compatibility Path (`packages/sandbox/src/clients/`)

`packages/sandbox/src/clients/` and `packages/sandbox/src/clients/transport/` implement the HTTP and custom WebSocket route-based compatibility API. Maintain these for compatibility, debugging, local development, fallback behavior, and bug fixes, but do not add new control-plane capabilities there by default.

The route-based client pattern is:

- **`BaseHttpClient`** — abstract route-based HTTP/WebSocket client with shared request/response handling
- **`SandboxClient`** — compatibility aggregator that exposes all specialized route-based clients
- **Specialized clients** — one per domain:
  - `CommandClient` — exec / execStream
  - `FileClient` — read, write, list, delete
  - `ProcessClient` — start, stop, list, signal
  - `PortClient` — port readiness streams
  - `GitClient` — clone, checkout, status
  - `UtilityClient` — ping, metadata
  - `InterpreterClient` — code interpreter sessions

When maintaining route-based compatibility, add or extend specialized clients under `packages/sandbox/src/clients/`. DO-to-container control capabilities belong in `packages/sandbox/src/container-control/` and `packages/sandbox-container/src/control-plane/`.

## Container Runtime (`packages/sandbox-container/src/`)

- **DI container** (`core/container.ts`) — manages service lifecycle and wiring
- **Router** — simple HTTP router with middleware
- **Control plane** (`control-plane/`) — primary container-side API called by the Sandbox DO
- **Handlers** (`handlers/`) — route-based compatibility handlers, thin layer that parses requests
- **Services** (`services/`) — business logic (`CommandService`, `FileService`, `ProcessService`, …)
- **Managers** (`managers/`) — stateful coordinators such as `ProcessManager`

Entry point: `packages/sandbox-container/src/index.ts` starts a Bun HTTP server on port 3000.

When adding a new container control operation:

1. Add/extend a service in `services/` for the business logic.
2. Add the control-plane method in `packages/sandbox-container/src/control-plane/`.
3. Mirror the call in `packages/sandbox/src/container-control/`.
4. Add unit tests on both sides; add an E2E test if it touches real shell/filesystem behavior.

Only add a route handler in `handlers/` and a route-based SDK client in `packages/sandbox/src/clients/` when maintaining HTTP/WebSocket compatibility.

## Monorepo Structure

Uses npm workspaces + [Turbo](https://turbo.build/):

- `packages/sandbox` — main SDK package (published)
- `packages/shared` — shared types and utilities (internal)
- `packages/sandbox-container` — container runtime (internal, bundled into image)
- `examples/` — working example projects
- `tooling/` — shared TypeScript configs

`turbo.json` orchestrates dependency-aware builds.

## Cross-Cutting Patterns

- **Sessions** — isolate execution contexts (cwd, env vars). Default session is auto-created; multiple sessions per sandbox are supported.
- **Ports** — expose internal services via preview URLs with token auth. Preview URL authorization is Durable Object-owned, while forwarding is active only after `exposePort()` activates the port for the current runtime. Production preview URLs require a custom domain with wildcard DNS (`*.yourdomain.com`); `.workers.dev` does not support the required subdomain patterns.
- **Container isolation** — handled at the Cloudflare platform level (VMs), not by SDK code.

## Container Base Image

The container runtime uses Ubuntu 22.04 with:

- Python 3.11 (matplotlib, numpy, pandas, ipython)
- Node.js 20 LTS
- Bun 1.x (powers the container HTTP server)
- Git, curl, wget, jq, and other common utilities

When modifying `packages/sandbox/Dockerfile`:

- Keep images lean — every MB affects cold start
- Pin versions for reproducibility
- Clean up package manager caches to reduce image size
