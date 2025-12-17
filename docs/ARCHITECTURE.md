# Sandbox SDK Architecture

This document provides an architectural overview for contributors and AI assistants working on this codebase.

## Overview

The Sandbox SDK enables secure, isolated code execution in containers on Cloudflare's edge. Workers can execute commands, manage files, run background processes, and expose services.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Your Worker Code                          │
│   const sandbox = getSandbox(env.Sandbox, 'my-sandbox');         │
│   const result = await sandbox.exec('python script.py');         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│              Sandbox Durable Object (packages/sandbox/)          │
│   • Manages container lifecycle and state                        │
│   • Routes requests to container via HTTP clients                │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTP/JSON
┌──────────────────────────▼───────────────────────────────────────┐
│              Container Runtime (packages/sandbox-container/)     │
│   • HTTP server inside Docker/VM                                 │
│   • Executes commands, manages files/processes                   │
└──────────────────────────────────────────────────────────────────┘
```

## Three-Layer Architecture

### Layer 1: `@cloudflare/sandbox` (packages/sandbox/)

The **public SDK** exported to npm.

| Directory                | Purpose                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/sandbox.ts`         | Main Durable Object - extends `Container<Env>` from `@cloudflare/containers` |
| `src/clients/`           | Modular HTTP clients (one per domain: commands, files, processes, etc.)      |
| `src/interpreter.ts`     | High-level `CodeInterpreter` API for Python/JS execution                     |
| `src/request-handler.ts` | `proxyToSandbox()` for preview URL routing                                   |

The Sandbox class is the main entry point. It manages container lifecycle, session state, port exposure, and delegates operations to specialized HTTP clients.

### Layer 2: `@repo/shared` (packages/shared/)

**Shared types and utilities** - internal package, not published.

| Directory              | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `src/types.ts`         | Core interfaces shared between SDK and container |
| `src/request-types.ts` | HTTP request/response DTOs                       |
| `src/errors/`          | Error codes, classes, and HTTP status mapping    |
| `src/logger/`          | Structured logging with trace context            |

### Layer 3: `@repo/sandbox-container` (packages/sandbox-container/)

The **container runtime** - bundled into Docker image, not published.

| Directory               | Purpose                              |
| ----------------------- | ------------------------------------ |
| `src/server.ts`         | HTTP server entry point              |
| `src/core/container.ts` | Dependency injection container       |
| `src/core/router.ts`    | HTTP router with middleware support  |
| `src/handlers/`         | Route handlers (one per domain)      |
| `src/services/`         | Business logic layer                 |
| `src/managers/`         | Stateful managers (processes, ports) |
| `src/session.ts`        | Shell session execution              |

## Client Architecture

The SDK uses a **modular client pattern**. `SandboxClient` aggregates domain-specific clients:

```
SandboxClient
    ├── CommandClient     (exec, streaming)
    ├── FileClient        (read, write, list, delete)
    ├── ProcessClient     (background processes)
    ├── PortClient        (expose services)
    ├── GitClient         (clone repos)
    ├── UtilityClient     (sessions, health)
    └── InterpreterClient (code execution)
```

All clients extend `BaseHttpClient` which provides:

- HTTP communication with automatic retry on transient errors
- Error response parsing into typed SDK errors

## Request Flow

A typical request flows through all layers:

```
Worker code
    → Sandbox DO method (e.g., exec())
        → Specialized client (e.g., CommandClient)
            → BaseHttpClient.doFetch()
                → HTTP to container
                    → Router → Handler → Service
                        → Shell execution
                    ← Response
                ← JSON
            ← Typed result
        ← ExecResult
    ← To user code
```

## Container Runtime Flow

```
HTTP Request
    → Router.route()
        → Middleware (CORS, logging)
            → Handler.handle()
                → Service (business logic)
                    → Manager (state) or Session (execution)
                ← Result
            ← Response
```

**Dependency Injection**: `core/container.ts` instantiates all services and handlers, enabling explicit dependencies and easy testing.

## Key Architectural Patterns

### Sessions

Sessions isolate execution contexts (working directory, environment variables). A default session is auto-created; custom sessions enable parallel isolated workloads. Sessions persist to Durable Object storage to survive DO restarts.

### Port Exposure

Services in the container can be exposed via preview URLs with token-based authentication. The Sandbox DO manages token generation and validation; requests are proxied through `proxyToSandbox()`.

### Error Flow

```
Container error → HTTP status → SDK error class → User code
```

Errors are transformed at each layer boundary. See `packages/shared/src/errors/` for error definitions and `packages/sandbox/src/errors/` for SDK-specific handling.

### Streaming

Real-time output (exec, logs) uses Server-Sent Events. The SDK provides both streaming and non-streaming variants of relevant methods.

## Platform Context

The SDK builds on **Cloudflare Containers**:

- **VM-based isolation**: Each sandbox runs in its own VM
- **Durable Objects**: Provide persistent identity and container lifecycle management
- **Edge distribution**: Sandboxes run geographically close to users

**Sandbox lifecycle**: Starting → Running → Sleeping (state lost) → Destroyed

State is ephemeral - files and processes exist only while the container is active.

For instance types, limits, and platform details, see the [official Cloudflare documentation](https://developers.cloudflare.com/sandbox/).

## Testing

| Type             | Command                               | Runtime                       | Purpose                              |
| ---------------- | ------------------------------------- | ----------------------------- | ------------------------------------ |
| Unit (SDK)       | `npm test -w @cloudflare/sandbox`     | Workers (vitest-pool-workers) | Test SDK logic with mocked container |
| Unit (Container) | `npm test -w @repo/sandbox-container` | Bun                           | Test container services              |
| E2E              | `npm run test:e2e`                    | Real Docker + Workers         | Full integration tests               |

E2E tests share a single container instance, using sessions for isolation. See [E2E_TESTING.md](./E2E_TESTING.md) for details.
