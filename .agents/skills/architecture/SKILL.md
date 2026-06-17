---
name: architecture
description: Use when navigating the codebase for the first time, adding a new client method, adding a new container service/control-plane method, or understanding how a request flows from Worker through the Sandbox DO into the container. Covers the three-layer architecture, control channel, container runtime structure, and monorepo layout. (project)
---

# Architecture

## Three-Layer Architecture

1. **`@cloudflare/sandbox` (`packages/sandbox/`)** — Public SDK published to npm
   - `Sandbox` class: Durable Object that manages the container lifecycle
   - `ContainerControlClient`: the DO-to-container SDK control client
   - `ContainerControlConnection`: capnweb over the `/rpc` WebSocket
   - `CodeInterpreter`: high-level API for Python/JS with structured outputs
   - `proxyToSandbox()`: request handler for preview URL routing

2. **`@repo/shared` (`packages/shared/`)** — Internal shared utilities
   - `rpc-types.ts`: shared `SandboxAPI` control contract
   - Type definitions used by both SDK and container runtime
   - Centralized error classes (`packages/shared/src/errors/`) and logging
   - **Not published to npm**

3. **`@repo/sandbox-container` (`packages/sandbox-container/`)** — Container runtime
   - Bun-based server running inside the Docker container
   - Dependency-injection container in `core/container.ts`
   - Control plane in `control-plane/` exposed over `/rpc`
   - Services for command execution, file operations, process management, etc.
   - **Not published to npm** (bundled into the Docker image)

## Request Flow

SDK control path:

```text
Worker
  → Sandbox DO (packages/sandbox)
    → ContainerControlClient (packages/sandbox/src/container-control/)
      → capnweb over /rpc WebSocket
        → SandboxControlAPI (packages/sandbox-container/src/control-plane/)
          → container services
            → execution runtime / terminal resources / filesystem
```

Errors flow back the same path: container service → control plane → capnweb → Sandbox DO → Worker, using custom error classes keyed by the `ErrorCode` enum.

## Control Path

The Sandbox Durable Object to container control path is:

- SDK side: `packages/sandbox/src/container-control/`
- Shared contract: `packages/shared/src/rpc-types.ts`
- Container side: `packages/sandbox-container/src/control-plane/`
- Current wire implementation: capnweb RPC over the `/rpc` WebSocket route

Control-channel capabilities belong in this path. Treat capnweb/RPC as a wire implementation detail, not the architectural boundary. The boundary is the typed control channel between the Sandbox DO and the container control API. SDK control capabilities live in `packages/sandbox/src/container-control/` on the SDK side and `packages/sandbox-container/src/control-plane/` on the container side.

The shared `@repo/shared` `SandboxAPI` interface defines the control API contract used by both sides.

Specialized non-control channels remain separate:

- `/rpc` — SDK control channel
- `/ws/terminal` — terminal WebSocket channel
- preview/proxy forwarding — user service traffic, not SDK control traffic

## Container Runtime (`packages/sandbox-container/src/`)

- **DI container** (`core/container.ts`) — manages service lifecycle and wiring
- **Control plane** (`control-plane/`) — container-side API called by the Sandbox DO
- **Services** (`services/`) — business logic (`ProcessService`, `FileService`, `PortService`, …)
- **Managers** (`managers/`) — stateful coordinators such as `ProcessManager`
- **Execution runtime** (`@repo/sandbox-execution`) — stateless commands, persistent command sessions, and lifecycle-managed processes
- **Session manager** (`services/session-manager.ts`) — explicit session lifecycle, locking, and runtime adapters
- **Terminal handler** (`handlers/terminal-ws-handler.ts`) — terminal WebSocket byte transport

Entry point: `packages/sandbox-container/src/index.ts` starts the Bun server on port 3000.

When adding a new container control operation:

1. Add/extend a service in `services/` for the business logic.
2. Add/extend shared types in `packages/shared/src/rpc-types.ts` if the API contract changes.
3. Add the control-plane method in `packages/sandbox-container/src/control-plane/`.
4. Mirror the call in `packages/sandbox/src/container-control/` if a new top-level domain or client behavior is needed.
5. Add unit tests on both sides; add an E2E test if it touches real shell/filesystem behavior.

## Monorepo Structure

Uses npm workspaces + Turbo:

- `packages/sandbox` — main SDK package (published)
- `packages/shared` — shared types and utilities (internal)
- `packages/sandbox-container` — container runtime (internal, bundled into image)
- `examples/` — working example projects
- `tooling/` — shared TypeScript configs

`turbo.json` orchestrates dependency-aware builds.

## Cross-Cutting Patterns

- **Execution** — top-level `exec()` / `startProcess()` are stateless. Explicit sessions isolate command state (cwd, env vars, aliases, functions) and are created via `createSession()`.
- **Ports** — expose internal services via preview URLs with token auth. Preview URL authorization is Durable Object-owned, while forwarding is active only after `exposePort()` activates the port for the current runtime. Production preview URLs require a custom domain with wildcard DNS (`*.yourdomain.com`); `.workers.dev` does not support the required subdomain patterns.
- **Container isolation** — handled at the Cloudflare platform level (VMs), not by SDK code.

## Container Base Image

The container runtime uses Ubuntu 22.04 with:

- Python 3.11 (matplotlib, numpy, pandas, ipython)
- Node.js 20 LTS
- Bun 1.x (powers the container server)
- Git, curl, wget, jq, and other common utilities

When modifying `packages/sandbox/Dockerfile`:

- Keep images lean — every MB affects cold start
- Pin versions for reproducibility
- Clean up package manager caches to reduce image size
