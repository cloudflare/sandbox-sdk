# Cap'n Web Transport Implementation Plan

## Progress Tracker

### Stage 1: capnweb Transport Adapter (SDK side)

- [x] 1.1 Add capnweb dependency
- [x] 1.2 Write unit tests for CapnwebTransport
- [x] 1.3 Extend TransportMode type
- [x] 1.4 Implement CapnwebTransport
- [x] 1.5 Update transport factory
- [x] 1.6 Export new transport
- [x] 1.7 Run full test suite

**Stage 1 Status:** ✅ Complete

### Stage 2: Container-Side Bridge Endpoint

- [x] 2.1 Add capnweb dependency to container
- [x] 2.2 Write unit tests for ContainerBridgeAPI
- [x] 2.3 Implement ContainerBridgeAPI RpcTarget
- [x] 2.4 Implement BunWebSocketShim (Bun ServerWebSocket → standard WebSocket adapter)
- [x] 2.5 Register capnweb WebSocket endpoint in server.ts
- [x] 2.6 Run full test suite

**Stage 2 Status:** ✅ Complete

### Stage 3: Wire Up and Integration Test

- [x] 3.1 Write E2E test for capnweb transport (7 tests)
- [x] 3.2 Add capnweb transport option to Sandbox DO
- [x] 3.3 Update SandboxClient to handle capnweb mode
- [x] 3.4 E2E tests pass (113/113 with HTTP transport)

**Stage 3 Status:** ✅ Complete

### Stage 4: Native RPC API on Container

- [x] 4.1 Implement SandboxRPCAPI with all domain methods
- [x] 4.2 Add sessionManager to Container dependencies
- [x] 4.3 Register native RPC API in server.ts for /capnweb connections
- [x] 4.4 Add watchPorts method to SandboxRPCAPI
- [x] 4.5 Add httpFetch/httpFetchStream bridge methods to SandboxRPCAPI
- [x] 4.6 Fix `fetch` naming conflict (renamed to `httpFetch`/`httpFetchStream`)
- [x] 4.7 E2E tests pass (all 113 passing)

**Stage 4 Status:** ✅ Complete

### Stage 5: ContainerConnection (Direct RPC Path)

- [x] 5.1 Create ContainerConnection class with typed ContainerRPCAPI interface
- [x] 5.2 Write unit tests for ContainerConnection (9 tests)
- [x] 5.3 Wire ContainerConnection into Sandbox DO (capnweb transport only)
- [x] 5.4 Route stream writeFile through ContainerConnection native pipe
- [x] 5.5 Add writeFileStream to FileService, SandboxRPCAPI, CapnwebTransport
- [x] 5.6 Update ISandbox writeFile to accept string | ReadableStream<Uint8Array>
- [x] 5.7 Fix stream-upload example Dockerfile to use current image tag

**Stage 5 Status:** ✅ Complete

### Stage 6: Migrate Sandbox DO to ContainerConnection (NOT STARTED)

Migrate sandbox.ts from `this.client.*` (SandboxClient + domain clients)
to `this.containerRPC.rpc()` (direct RPC calls). This enables deleting
the entire old transport/client/handler stack.

See `capnweb-cleanup-plan.md` for the full execution plan.

**Blocker:** The 50+ unit tests in `sandbox.test.ts` and
`process-readiness.test.ts` mock `sandbox.client.*` methods. Migrating
sandbox.ts requires simultaneously updating these tests. The recommended
approach is to create a `ClientShim` that wraps `ContainerConnection.rpc()`
with the same interface as `SandboxClient`, swap it in, then update the
test mocks.

### Stage 7: Delete Legacy Code (NOT STARTED)

Delete ~8300 lines of transport, client, handler, and router code.
See `capnweb-cleanup-plan.md` for the file-by-file deletion plan.

### Stage 8: Advanced capnweb Features (FUTURE)

- [ ] Bidirectional callbacks for event streams
- [ ] Promise pipelining for batched operations
- [ ] RpcTarget sub-objects for domain isolation
- [ ] Workers RPC passthrough
- [ ] Contribute binary frame support to capnweb

---

## Current Architecture

```
Worker → Sandbox DO → SandboxClient → CapnwebTransport → httpFetch bridge → SandboxRPCAPI → Services
                  ↘                                                                         ↗
                   ContainerConnection → capnweb native pipe → SandboxRPCAPI.writeFileStream()
```

Most operations flow through the existing SandboxClient → domain clients → CapnwebTransport
→ httpFetch/httpFetchStream bridge path. Stream file writes take the direct path through
ContainerConnection → native RPC pipe with backpressure.

## Test Summary

| Suite                       | Count | Status                                    |
| --------------------------- | ----- | ----------------------------------------- |
| SDK unit tests              | 563   | ✅ (554 existing + 9 ContainerConnection) |
| SDK capnweb transport tests | 22    | ✅ (included in 563)                      |
| Container unit tests        | 602   | ✅ (1 pre-existing fail)                  |
| Container bridge tests      | 9     | ✅ (included in 602)                      |
| Container shim tests        | 13    | ✅ (included in 602)                      |
| E2E tests                   | 113   | ✅                                        |

## New Files Created

| File                                                               | Lines | Purpose                                                   |
| ------------------------------------------------------------------ | ----- | --------------------------------------------------------- |
| `packages/sandbox/src/container-connection.ts`                     | ~300  | Direct capnweb RPC connection + ContainerRPCAPI interface |
| `packages/sandbox/src/clients/transport/capnweb-transport.ts`      | ~310  | ITransport-compatible capnweb adapter (bridge mode)       |
| `packages/sandbox-container/src/rpc/sandbox-api.ts`                | ~950  | Native RPC target covering all service domains            |
| `packages/sandbox-container/src/handlers/bun-ws-shim.ts`           | ~80   | Bun ServerWebSocket → standard WebSocket adapter          |
| `packages/sandbox-container/src/handlers/capnweb-bridge.ts`        | ~70   | HTTP bridge RpcTarget (transitional)                      |
| `tests/e2e/capnweb-transport.test.ts`                              | ~240  | 7 E2E tests for capnweb path                              |
| `packages/sandbox/tests/capnweb-transport.test.ts`                 | ~500  | 22 unit tests for CapnwebTransport                        |
| `packages/sandbox/tests/container-connection.test.ts`              | ~160  | 9 unit tests for ContainerConnection                      |
| `packages/sandbox-container/tests/handlers/bun-ws-shim.test.ts`    | ~170  | 13 unit tests for BunWebSocketShim                        |
| `packages/sandbox-container/tests/handlers/capnweb-bridge.test.ts` | ~280  | 9 unit tests for ContainerBridgeAPI                       |
| `capnweb-cleanup-plan.md`                                          | ~250  | Migration plan for deleting legacy code                   |
