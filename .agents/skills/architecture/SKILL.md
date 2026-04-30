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

```
Worker
  → Sandbox DO (packages/sandbox)
    → Container HTTP API on port 3000 (packages/sandbox-container)
      → Bun runtime
        → Shell commands / filesystem
```

Errors flow back the same path: container → Sandbox DO → Worker, using the custom error classes in `packages/shared/src/errors/` keyed by the `ErrorCode` enum.

## Client Architecture (`packages/sandbox/src/clients/`)

The SDK uses a modular client pattern:

- **`BaseClient`** — abstract HTTP client with shared request/response handling
- **`SandboxClient`** — aggregator that exposes all specialized clients
- **Specialized clients** — one per domain:
  - `CommandClient` — exec / execStream
  - `FileClient` — read, write, list, delete
  - `ProcessClient` — start, stop, list, signal
  - `PortClient` — expose / preview URLs
  - `GitClient` — clone, checkout, status
  - `UtilityClient` — ping, metadata
  - `InterpreterClient` — code interpreter sessions

When adding a new SDK capability, add a new specialized client (or extend an existing one) and wire it into `SandboxClient`.

## Container Runtime (`packages/sandbox-container/src/`)

- **DI container** (`core/container.ts`) — manages service lifecycle and wiring
- **Router** — simple HTTP router with middleware
- **Handlers** (`handlers/`) — route handlers, thin layer that parses requests
- **Services** (`services/`) — business logic (`CommandService`, `FileService`, `ProcessService`, …)
- **Managers** (`managers/`) — stateful coordinators (`ProcessManager`, `PortManager`)

Entry point: `packages/sandbox-container/src/index.ts` starts a Bun HTTP server on port 3000.

When adding a new container endpoint:

1. Add/extend a service in `services/` for the business logic.
2. Add a handler in `handlers/` that parses the request and calls the service.
3. Register the route in the router.
4. Mirror the call in a SDK client under `packages/sandbox/src/clients/`.
5. Add unit tests on both sides; add an E2E test if it touches real shell/filesystem behavior.

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
- **Ports** — expose internal services via preview URLs with token auth. Auto-cleaned on sandbox sleep. Production preview URLs require a custom domain with wildcard DNS (`*.yourdomain.com`); `.workers.dev` does not support the required subdomain patterns.
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
