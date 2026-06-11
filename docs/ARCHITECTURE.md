# Sandbox SDK Architecture

This document provides an architectural overview for contributors and AI assistants working on this codebase.

## Overview

The Sandbox SDK enables secure, isolated code execution in containers on Cloudflare's edge. Workers can execute commands, manage files, run background processes, and expose services.

```text
┌──────────────────────────────────────────────────────────────────┐
│                        Your Worker Code                          │
│   const sandbox = getSandbox(env.Sandbox, 'my-sandbox');         │
│   const result = await sandbox.exec('python script.py');         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│        Sandbox Durable Object (packages/sandbox/)                │
│   • Manages container lifecycle and session state                │
│   • Delegates container operations to ContainerControlClient     │
└──────────────────────────┬───────────────────────────────────────┘
                           │ capnweb RPC over /rpc WebSocket
┌──────────────────────────▼───────────────────────────────────────┐
│        Container Runtime (packages/sandbox-container/)           │
│   • Bun server inside Docker/VM, SandboxControlAPI on /rpc       │
│   • Executes commands, manages files/processes/sessions          │
└──────────────────────────────────────────────────────────────────┘
```

The DO-to-container control path is a typed control channel over `/rpc`. Preview/proxy traffic and PTY terminal WebSockets are separate channels with their own purposes.

## Three-Layer Architecture

### Layer 1: `@cloudflare/sandbox` (`packages/sandbox/`)

The public SDK exported to npm.

| Directory                | Purpose                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/sandbox.ts`         | Main Durable Object - extends `Container<Env>` from `@cloudflare/containers` |
| `src/container-control/` | DO-to-container control client and `/rpc` connection lifecycle               |
| `src/interpreter.ts`     | High-level `CodeInterpreter` API for Python/JS execution                     |
| `src/request-handler.ts` | `proxyToSandbox()` for preview URL routing                                   |
| `src/pty/`, `src/xterm/` | PTY terminal proxy and browser terminal helpers                              |
| `src/storage-mount/`     | R2/S3 mount and egress helpers                                               |

The `Sandbox` class is the main entry point. It manages container lifecycle, session state, port exposure, backups, mounts, and delegates container operations to `ContainerControlClient`.

### Layer 2: `@repo/shared` (`packages/shared/`)

Internal shared types and utilities. This package is not published independently.

| Directory/file     | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `src/rpc-types.ts` | Typed control API contract shared by SDK and container      |
| `src/types.ts`     | Public SDK data types and operation result shapes           |
| `src/errors/`      | Error codes, classes, contexts, suggestions, status mapping |
| `src/logger/`      | Structured logging with trace context                       |
| `src/sse.ts`       | SSE frame parsing for SDK-facing event streams              |

### Layer 3: `@repo/sandbox-container` (`packages/sandbox-container/`)

The container runtime bundled into the Docker image.

| Directory/file          | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `src/server.ts`         | Bun server entry point on port 3000             |
| `src/control-plane/`    | Container-side implementation of `SandboxAPI`   |
| `src/core/container.ts` | Dependency injection container                  |
| `src/services/`         | Business logic layer                            |
| `src/managers/`         | Stateful managers such as process/file managers |
| `src/session.ts`        | Persistent bash session execution               |
| `src/handlers/pty-ws-*` | PTY WebSocket handling                          |

## Control Channel Architecture

The SDK-side control path is implemented in `packages/sandbox/src/container-control/`.

```text
ContainerControlClient
  -> ContainerControlConnection
  -> DeferredTransport
  -> capnweb RpcSession
  -> WebSocket upgrade to http://localhost:3000/rpc
```

`ContainerControlClient` exposes typed domains matching `SandboxAPI`:

```text
commands, files, processes, ports, git, interpreter, utils, backup, watch, tunnels
```

`ContainerControlConnection` owns:

- `/rpc` WebSocket upgrade and 503 retry during container startup;
- capnweb `RpcSession` creation;
- the deferred transport that queues sends until the WebSocket is active;
- close/error detection and reconnection handoff.

The container-side control plane is implemented in `packages/sandbox-container/src/control-plane/`. `SandboxControlAPI` exposes nested capnweb `RpcTarget` domains and calls services directly.

## Request Flow

A typical command execution flows through all layers:

```text
Worker code
  -> sandbox.exec("echo hello")
  -> Sandbox DO method
  -> ContainerControlClient.commands.execute(...)
  -> capnweb call over /rpc
  -> SandboxControlAPI.commands.execute(...)
  -> ProcessService.executeCommand(...)
  -> ExecutionService.execute(...)
  -> SessionManager.executeInSession(...)
  -> Session.exec(...)
  -> persistent bash shell
```

Streaming operations return `ReadableStream<Uint8Array>` values over capnweb. The bytes are SSE-framed so existing SDK consumers can parse them with the same code, but the transport is the `/rpc` control channel.

## Container Runtime Flow

```text
/rpc WebSocket
  -> newBunWebSocketRpcSession(...)
  -> SandboxControlAPI
  -> Service
  -> Manager or Session
```

The Bun server also keeps `/ws/pty` for terminal sessions. Non-WebSocket HTTP requests that are not preview/proxy traffic are not the SDK control plane.

`core/container.ts` instantiates services and the PTY handler with explicit dependencies. Control-plane methods call these services directly.

## Key Architectural Patterns

### Sessions

Sessions isolate execution contexts such as working directory and environment variables. A default session is auto-created; custom sessions enable parallel isolated workloads. `SessionManager` serializes command execution per session and owns session lifecycle.

### Command Execution

`Session` maintains a persistent bash shell. Foreground `exec()` preserves shell state and captures output through temp files. Background `execStream()` and process APIs use FIFOs, labelers, and exit-code files for streaming and cancellation.

See [SESSION_EXECUTION.md](./SESSION_EXECUTION.md) for details.

### Port Exposure

Services in the container can be exposed via preview URLs with token-based authentication. The Sandbox DO owns preview URL authorization and current-runtime activation. Requests are routed through `proxyToSandbox()` and only forward after `exposePort()` has activated the port for the current runtime.

### Error Flow

```text
ServiceError / thrown control-plane error
  -> capnweb propagation
  -> ContainerControlClient.translateRPCError(...)
  -> SDK SandboxError subclass
  -> user code
```

Transport-level failures surface as `RPCTransportError` with structured context such as `peer_closed`, `connection_failed`, `upgrade_failed`, or `protocol_error`.

### Streaming and Lifecycle

The control channel is multiplexed. A method that returns a stream can resolve before the underlying operation is complete. `ContainerControlClient` polls capnweb session stats to keep the Durable Object active while calls or returned streams are still in flight.

## Platform Context

The SDK builds on Cloudflare Containers:

- VM-based isolation: each sandbox runs in its own VM.
- Durable Objects: provide persistent identity and container lifecycle management.
- Edge distribution: sandboxes run geographically close to users.

Sandbox lifecycle: starting -> running -> sleeping (ephemeral state lost) -> destroyed.

For instance types, limits, and platform details, see the official Cloudflare documentation.

## Testing

| Type             | Command                               | Runtime                       | Purpose                              |
| ---------------- | ------------------------------------- | ----------------------------- | ------------------------------------ |
| Unit (SDK)       | `npm test -w @cloudflare/sandbox`     | Workers (vitest-pool-workers) | Test SDK logic with mocked container |
| Unit (Container) | `npm test -w @repo/sandbox-container` | Bun                           | Test container services              |
| E2E              | `npm run test:e2e`                    | Real Docker + Workers         | Full integration tests               |

E2E tests share a single container instance, using sessions for isolation. See [E2E_TESTING.md](./E2E_TESTING.md) for details.
