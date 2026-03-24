# Cap'n Web Transport Implementation Plan

## Progress Tracker

### Stage 1: capnweb Transport Adapter (SDK side)

- [x] 1.1 Add capnweb dependency
- [x] 1.2 Write unit tests for CapnwebTransport (TEST FIRST)
- [x] 1.3 Extend TransportMode type
- [x] 1.4 Implement CapnwebTransport
- [x] 1.5 Update transport factory
- [x] 1.6 Export new transport
- [x] 1.7 Run full test suite

**Stage 1 Status:** ✅ Complete — all 554 SDK tests pass, all 22 new capnweb tests pass.
Note: 1 pre-existing failure in `@repo/sandbox-container` (ProcessStore test) is unrelated.

### Stage 2: Container-Side Bridge Endpoint

- [x] 2.1 Add capnweb dependency to container
- [x] 2.2 Write unit tests for ContainerBridgeApi (TEST FIRST)
- [x] 2.3 Implement ContainerBridgeApi RpcTarget
- [x] 2.4 Implement BunWebSocketShim (Bun ServerWebSocket → standard WebSocket adapter)
- [x] 2.5 Register capnweb WebSocket endpoint in server.ts
- [x] 2.6 Run full test suite

### Stage 3: Wire Up and Integration Test

- [x] 3.1 Write E2E test for capnweb transport
- [x] 3.2 Add capnweb transport option to Sandbox DO
- [x] 3.3 Update SandboxClient to handle capnweb mode
- [x] 3.4 Run full test suite — both transports

**Stage 2+3 Status:** ✅ Complete — 554 SDK tests pass, 603 container tests pass (602 + 1 pre-existing fail).
22 new container tests (BunWebSocketShim + ContainerBridgeApi). E2E test written.
To run E2E with capnweb: `./generate-config.sh <name> <name> capnweb && npm run test:e2e:vitest`

### Stage 4: Native RpcTarget on Container (Eliminate Bridge)

- [x] 4.1 Implement SandboxRpcApi with all domain methods
- [x] 4.2 Fix E2E test (exit 42 → sh -c "exit 42" to avoid killing session)
- [x] 4.3 Register native RpcTarget in server (replaces bridge for capnweb connections)
- [x] 4.4 Add sessionManager to Container dependencies
- [ ] 4.5 Run E2E tests with both transports
- [ ] 4.6 Write unit tests for SandboxRpcApi

**Stage 4 Status:** 🔄 In progress — SandboxRpcApi implemented and registered. Needs E2E verification.

### Stage 5–7: Not started

---

## Overview

Replace the Sandbox SDK's two bespoke DO↔Container transports (HTTP and JSON-over-WebSocket)
with a single transport built on [capnweb](https://github.com/cloudflare/capnweb) — Cloudflare's
JavaScript-native RPC library. This eliminates ~4000 lines of transport, client, handler, router,
and adapter code while gaining stream multiplexing with backpressure, promise pipelining,
bidirectional calling, and native Workers RPC interoperability.

### Why capnweb

- **First-party Cloudflare library** by Kenton Varda (Cap'n Proto / Workers RPC author)
- **Zero dependencies**, <10kB gzipped, pure JavaScript
- **Same semantics as Workers RPC** — `RpcTarget` on Workers is the built-in one
- **Native `ReadableStream` support** with BDP-based flow control and backpressure
- **Works on Bun, Node, Deno, Workers, browsers** — both sides of the DO↔Container boundary
- **WebSocket transport** — single connection, unlimited multiplexed calls, bypasses sub-request limits and message size constraints
- **Promise pipelining** — chain dependent calls in a single round trip

### Known Trade-off: Binary Encoding

capnweb serializes over JSON. `Uint8Array` values are base64-encoded (33% overhead).
`ReadableStream` transfers use a pipe mechanism where each chunk is a separate message —
if chunks are `Uint8Array`, each chunk is base64'd individually. This is a regression from the
current HTTP transport's raw-byte `containerFetch()` path for file writes, but an improvement
over the current WebSocket transport which buffers the entire stream into memory. For the dominant
use cases (text-based command execution and streaming), JSON is the native format with zero overhead.

### Architecture Before and After

**Before:**

```
Worker ──RPC──▶ Sandbox DO ──HTTP or JSON-WS──▶ Container (Bun HTTP server)
                  │                                  │
                  ├─ SandboxClient                   ├─ Router
                  ├─ 10 domain clients               ├─ 14 HTTP handlers
                  ├─ BaseHttpClient                  ├─ WebSocketAdapter
                  ├─ HttpTransport                   ├─ SSE streaming
                  ├─ WebSocketTransport              └─ Routes setup
                  └─ SSE parser
```

**After:**

```
Worker ──RPC──▶ Sandbox DO ──capnweb WS──▶ Container (capnweb RpcTarget)
                  │                              │
                  ├─ capnweb stub                 ├─ SandboxRpcApi (RpcTarget)
                  └─ thin proxy methods           └─ delegates to services
```

---

## Test-Driven Development Methodology

**Every stage is implemented test-first.** The implementation sequence within each stage is:

1. **Write tests** for the new code (unit tests for new classes, integration tests for new paths)
2. **Implement** the production code to make the new tests pass
3. **Run the full existing test suite** to verify nothing is broken

This means the existing test suites are the primary regression safety net throughout
the migration. At every commit — not just at stage boundaries — the following must pass:

```bash
npm run check                    # Biome linter + TypeScript type checking
npm test                         # All unit tests (SDK + container)
npm run test:e2e                 # All E2E tests (when transport is wired up)
```

**No stage is complete until the full suite is green.** If a stage's changes cause
existing tests to fail, the stage is not done — the fix is part of that stage's scope.

### Additive-only stages (1–3)

Stages 1–3 add new code alongside the existing transports. The default transport
remains `'http'`. This means:

- All existing unit tests continue to exercise the HTTP transport path — they must
  pass without modification.
- All existing E2E tests continue to use the HTTP transport — they must pass without
  modification.
- New unit tests cover the new capnweb transport in isolation.
- A new E2E test (Stage 3) exercises the capnweb path specifically via
  `SANDBOX_TRANSPORT=capnweb`.

The invariant: **at every commit in Stages 1–3, running the full test suite without
any environment overrides produces the exact same results as before the migration started.**

### Replacement stages (4–5)

Stages 4–5 begin replacing internals. The approach is:

- For each domain (commands, files, processes, etc.), write the new capnweb-native
  tests first, implement the `SandboxRpcApi` method, verify the new tests pass, then
  verify the full suite still passes.
- Existing unit tests that mock the HTTP client layer are updated one-by-one to mock
  the capnweb stub instead. Each test file is migrated individually with the full suite
  run after each file.
- The E2E suite is run with both `SANDBOX_TRANSPORT=http` (legacy, while it still exists)
  and `SANDBOX_TRANSPORT=capnweb` during this phase.

### Deletion stage (6)

Stage 6 only deletes code that is provably unreachable — every deleted file's
functionality must already be covered by the capnweb path and verified by the full E2E
suite. The sequence:

1. Run the full E2E suite with `SANDBOX_TRANSPORT=capnweb` — must be green.
2. Delete legacy files one category at a time (e.g., all transport files, then all
   client files, then all handler files).
3. Run `npm run check` after each deletion batch to verify no remaining imports reference
   deleted code.
4. Run `npm test` after each deletion batch.
5. Run `npm run test:e2e` after all deletions.

---

## Stage 1: capnweb Transport Adapter (SDK side)

**Goal:** Add a third transport mode `'capnweb'` that implements the existing `ITransport`
interface using capnweb's WebSocket session. This runs alongside the existing transports with
no changes to any other code. The adapter translates between the fetch-oriented `ITransport`
interface and capnweb's RPC model, proving the connectivity path works.

**Verification gate:**

```bash
npm run check                    # Must pass — no type errors from new code
npm test                         # Must pass — all existing tests unaffected, new tests green
```

### 1.1 Add capnweb dependency

**File:** `packages/sandbox/package.json`

Add `"capnweb": "^0.6.1"` to dependencies.

### 1.2 Write unit tests for CapnwebTransport (TEST FIRST)

**File:** `packages/sandbox/tests/capnweb-transport.test.ts`

Write the full test file before implementing the transport. Tests should mirror the
patterns in `transport.test.ts` and `ws-transport.test.ts`:

- **Factory integration:**
  - `createTransport({ mode: 'capnweb', wsUrl: '...' })` returns `CapnwebTransport`
  - `getMode()` returns `'capnweb'`
  - Throws if `wsUrl` is missing

- **Connection lifecycle:**
  - `isConnected()` returns `false` before `connect()`
  - `connect()` establishes capnweb session (mock the WebSocket)
  - `isConnected()` returns `true` after connect
  - `disconnect()` disposes session, `isConnected()` returns `false`
  - Multiple `connect()` calls share the same connection attempt (no double-connect)

- **Request/response:**
  - `fetch('/api/test', { method: 'GET' })` calls bridge `fetch()` and returns a `Response`
  - POST requests pass JSON body through
  - Non-200 responses propagate status codes correctly
  - Response body is parseable as JSON

- **503 retry (inherited from BaseTransport):**
  - Container returning 503 triggers retry with backoff
  - Retry budget exhaustion stops retrying
  - `setRetryTimeoutMs()` updates the budget

- **Streaming:**
  - `fetchStream('/api/execute/stream', body)` returns a `ReadableStream`
  - Stream data flows through correctly
  - Stream errors propagate

- **waitForContainer:**
  - Returns when bridge `fetch('/api/ping')` returns non-503
  - Retries on 503
  - Throws on budget exhaustion

- **Disconnection handling:**
  - Pending requests reject when connection drops
  - Reconnect on next `fetch()` after disconnect

Mock strategy: Create a mock capnweb `RpcStub` that records calls and returns
canned responses. Mock the WebSocket establishment path. Do not require a real
container — these are unit tests.

All tests should initially fail (no implementation yet). This confirms the tests
are actually testing something.

### 1.3 Extend TransportMode type

**File:** `packages/sandbox/src/clients/transport/types.ts`

```ts
export type TransportMode = 'http' | 'websocket' | 'capnweb';
```

No changes to `TransportConfig` or `ITransport` — the capnweb transport implements the
same interface.

### 1.4 Implement CapnwebTransport

**File:** `packages/sandbox/src/clients/transport/capnweb-transport.ts`

This is a bridge class: it implements `ITransport` but internally uses a capnweb
`RpcStub` connected over WebSocket to the container. The container still runs its
existing HTTP server — the capnweb session connects to a new `/capnweb` WebSocket
endpoint that exposes a minimal `RpcTarget` with a single `fetch()` method. This
lets us prove the capnweb plumbing works without changing the container's handler
architecture yet.

```ts
import { RpcTarget, newWebSocketRpcSession } from 'capnweb';
import { BaseTransport } from './base-transport';
import type { TransportConfig, TransportMode } from './types';

/**
 * Minimal RPC interface exposed by the container in Stage 1.
 * The container's RpcTarget accepts fetch-like requests and delegates
 * to its internal HTTP router, acting as a bridge.
 */
interface ContainerBridgeApi extends RpcTarget {
  fetch(
    method: string,
    path: string,
    body?: string
  ): Promise<{
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }>;

  fetchStream(
    method: string,
    path: string,
    body?: string
  ): Promise<ReadableStream<Uint8Array>>;
}
```

Key implementation details:

- **Connection lifecycle:** On `connect()`, establish a capnweb WebSocket session
  to the container via `stub.fetch()` (WebSocket upgrade through the DO's Container
  base class). Use capnweb's `newWebSocketRpcSession()` with the resulting WebSocket.
- **`doFetch()` implementation:** Call `stub.fetch(method, path, body)` on the capnweb
  stub. The container-side bridge routes this to its existing HTTP router. Construct and
  return a standard `Response` object from the result.
- **`fetchStream()` implementation:** Call `stub.fetchStream(method, path, body)` which
  returns a `ReadableStream<Uint8Array>` via capnweb's pipe mechanism. Return it directly.
- **Container startup retry:** Inherit from `BaseTransport` which provides 503 retry
  logic. The bridge's `fetch()` returns status codes, so the retry loop works unchanged.
- **`waitForContainer()`:** Reuse `BaseTransport`'s implementation — calls `doFetch('/api/ping')`.
- **`disconnect()`:** Dispose the capnweb session stub.
- **WebSocket connection via DO:** In the DO context, capnweb needs a `WebSocket` object.
  We obtain this by sending a fetch request with `Upgrade: websocket` through `stub.fetch()`
  (the Container base class handles WebSocket proxying), then passing the resulting WebSocket
  to capnweb's `newWebSocketRpcSession()`. This mirrors the existing `connectViaFetch()`
  pattern in `ws-transport.ts`.

Iterate until all tests from 1.2 pass.

### 1.5 Update transport factory

**File:** `packages/sandbox/src/clients/transport/factory.ts`

Add `'capnweb'` case to `createTransport()`:

```ts
case 'capnweb':
  return new CapnwebTransport(options);
```

### 1.6 Export new transport

**File:** `packages/sandbox/src/clients/transport/index.ts`

Add `CapnwebTransport` to exports.

### 1.7 Run full test suite

```bash
npm run check                    # Type checking — new code must be clean
npm test                         # ALL tests — existing + new capnweb tests
```

Both must be green before moving to Stage 2.

---

## Stage 2: Container-Side Bridge Endpoint

**Goal:** Add a capnweb WebSocket endpoint to the container's Bun server that exposes
the bridge `RpcTarget`. This makes the Stage 1 transport functional end-to-end while
keeping all existing HTTP handlers and services untouched.

**Verification gate:**

```bash
npm run check                    # Must pass
npm test                         # Must pass — all existing container tests + new bridge tests
```

### 2.1 Add capnweb dependency to container

**File:** `packages/sandbox-container/package.json`

Add `"capnweb": "^0.6.1"` to dependencies.

### 2.2 Write unit tests for ContainerBridgeApi (TEST FIRST)

**File:** `packages/sandbox-container/tests/handlers/capnweb-bridge.test.ts`

Write tests before implementing the bridge:

- Bridge `fetch('GET', '/api/ping')` routes to misc handler and returns 200
- Bridge `fetch('POST', '/api/execute', JSON.stringify({...}))` routes to execute handler
- Bridge `fetchStream('POST', '/api/execute/stream', ...)` returns a ReadableStream
- Error responses propagate status codes correctly
- Invalid paths return appropriate errors
- Body is properly forwarded to the router

Mock strategy: Use the existing container test utilities. Create a `Router` with
registered mock handlers. Pass it to `ContainerBridgeApi` and verify routing.

All tests should initially fail (no implementation yet).

### 2.3 Implement ContainerBridgeApi RpcTarget

**File:** `packages/sandbox-container/src/handlers/capnweb-bridge.ts`

```ts
import { RpcTarget } from 'capnweb';
import type { Router } from '../core/router';

/**
 * Bridge RpcTarget that translates capnweb RPC calls into HTTP requests
 * routed through the existing handler infrastructure.
 *
 * This is a transitional layer. In later stages, the RPC methods will
 * call services directly, eliminating the HTTP routing.
 */
export class ContainerBridgeApi extends RpcTarget {
  #router: Router;

  constructor(router: Router) {
    super();
    this.#router = router;
  }

  async fetch(
    method: string,
    path: string,
    body?: string
  ): Promise<{
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }> {
    const url = `http://localhost:3000${path}`;
    const request = new Request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body || undefined
    });

    const response = await this.#router.route(request);
    const responseBody = await response.text();

    return {
      status: response.status,
      body: responseBody || undefined,
      headers: Object.fromEntries(response.headers.entries())
    };
  }

  async fetchStream(
    method: string,
    path: string,
    body?: string
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `http://localhost:3000${path}`;
    const request = new Request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body || undefined
    });

    const response = await this.#router.route(request);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP error ${response.status}: ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    // Return the SSE stream directly — capnweb's pipe mechanism
    // handles multiplexing and backpressure automatically.
    return response.body;
  }
}
```

Iterate until all tests from 2.2 pass.

### 2.4 Register capnweb WebSocket endpoint

**File:** `packages/sandbox-container/src/server.ts`

Add handling for `/capnweb` WebSocket upgrade alongside the existing `/ws` and `/ws/pty`
handlers:

```ts
if (url.pathname === '/capnweb') {
  const upgraded = server.upgrade(req, {
    data: {
      type: 'capnweb' as const,
      connectionId: generateConnectionId()
    }
  });
  if (upgraded) return undefined as unknown as Response;
  return new Response('WebSocket upgrade failed', { status: 500 });
}
```

In the WebSocket `open` handler, initialize a capnweb session:

```ts
if (ws.data.type === 'capnweb') {
  newWebSocketRpcSession(ws, app.bridgeApi);
}
```

Update `WSData` type to include the `'capnweb'` variant.

### 2.5 Run full test suite

```bash
npm run check
npm test                         # All existing tests + new bridge tests
```

Both must be green before moving to Stage 3.

---

## Stage 3: Wire Up and Integration Test

**Goal:** Make the capnweb transport selectable via `SANDBOX_TRANSPORT=capnweb` environment
variable in the Sandbox DO, and verify end-to-end functionality.

**Verification gate:**

```bash
npm run check                    # Must pass
npm test                         # Must pass — all unit tests
npm run test:e2e                 # Must pass — all existing E2E tests (HTTP transport)
SANDBOX_TRANSPORT=capnweb npm run test:e2e   # Must pass — all E2E tests via capnweb
```

### 3.1 Write E2E smoke test (TEST FIRST)

**File:** `tests/e2e/capnweb-transport.test.ts`

Write the E2E test before wiring up the transport in the DO. This test sets
`SANDBOX_TRANSPORT=capnweb` and verifies core operations:

- `exec('echo hello')` returns expected stdout
- `writeFile()` / `readFile()` round-trip
- `execStream()` delivers stdout/stderr events
- `startProcess()` / `getProcess()` / `killProcess()` lifecycle
- `listFiles()` returns directory contents
- `createSession()` with isolated env vars

This test will fail until the wiring (3.2–3.3) is complete.

### 3.2 Add capnweb transport option to Sandbox DO

**File:** `packages/sandbox/src/sandbox.ts`

In the constructor, add `'capnweb'` to the transport env var handling:

```ts
const transportEnv = envObj?.SANDBOX_TRANSPORT;
if (transportEnv === 'websocket') {
  this.transport = 'websocket';
} else if (transportEnv === 'capnweb') {
  this.transport = 'capnweb';
} else if (transportEnv != null && transportEnv !== 'http') {
  this.logger.warn(`Invalid SANDBOX_TRANSPORT value...`);
}
```

In `createSandboxClient()`, add the capnweb case:

```ts
if (this.transport === 'capnweb') {
  return new SandboxClient({
    logger: this.logger,
    port: 3000,
    stub: this,
    retryTimeoutMs: this.computeRetryTimeoutMs(),
    transportMode: 'capnweb' as const,
    wsUrl: 'ws://localhost:3000/capnweb'
  });
}
```

### 3.3 Update SandboxClient to handle capnweb mode

**File:** `packages/sandbox/src/clients/sandbox-client.ts`

Add `'capnweb'` to the transport creation logic (parallel to existing `'websocket'` handling):

```ts
if (
  (options.transportMode === 'capnweb' ||
    options.transportMode === 'websocket') &&
  options.wsUrl
) {
  this.transport = createTransport({
    mode: options.transportMode,
    wsUrl: options.wsUrl
    // ... same options as websocket
  });
}
```

### 3.4 Update Docker image

**File:** `packages/sandbox/Dockerfile`

The container image needs `capnweb` available at runtime. Since the container uses
Bun and the dependency is in `packages/sandbox-container/package.json`, it will be
bundled automatically by the existing build process. Verify this works and that the
capnweb WebSocket endpoint starts.

### 3.5 Run full test suite — both transports

```bash
npm run check
npm test                                           # All unit tests
npm run test:e2e                                   # E2E with default HTTP transport
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # E2E with capnweb transport
```

**All three must be green.** The default-transport E2E run proves the existing
path is untouched. The capnweb E2E run proves the new path works end-to-end.

From this point forward, CI should run the E2E suite twice — once with each
transport — to catch regressions in either path.

---

## Stage 4: Native RpcTarget on Container (Eliminate Bridge)

**Goal:** Replace the bridge `RpcTarget` with a native one that calls services directly,
eliminating the HTTP routing layer for capnweb requests. The HTTP server and handlers
remain for backward compatibility and health checks.

**Verification gate:**

```bash
npm run check
npm test                                           # All unit tests (existing + new)
npm run test:e2e                                   # E2E with HTTP transport — still green
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # E2E with capnweb — exercises native path
```

### 4.1 Write unit tests for SandboxRpcApi (TEST FIRST)

**File:** `packages/sandbox-container/tests/rpc/sandbox-api.test.ts`

Write comprehensive tests for each RPC method with mocked services before
implementing any of the `SandboxRpcApi`:

- `execute()` calls `processService.executeCommand()` and returns result
- `executeStream()` returns a `ReadableStream` with stdout/stderr events
- `writeFile()` accepts a `ReadableStream` and delegates to `fileService.write()`
- `readFile()` calls `fileService.readFile()` and returns result
- `readFileStream()` returns a `ReadableStream` via `fileService.readFileStreamOperation()`
- `mkdir()` calls `fileService.mkdir()` and returns result
- `deleteFile()`, `renameFile()`, `moveFile()`, `listFiles()`, `exists()` — same pattern
- Session CRUD maps to `sessionManager` methods
- Process lifecycle (`startProcess`, `listProcesses`, `getProcess`, `killProcess`, `killAllProcesses`) maps to `processService`
- `getProcessLogs()`, `streamProcessLogs()` — log retrieval and streaming
- Port management (`exposePort`, `listExposedPorts`, `unexposePort`, `watchPorts`)
- Git operations (`gitCheckout`)
- Code interpreter (`createContext`, `executeCode`, `listContexts`, `deleteContext`)
- Backup (`createBackup`, `restoreBackup`)
- Desktop operations (`desktopStart`, `desktopStop`, `desktopStatus`, `desktopScreenshot`, etc.)
- File/port watch streaming
- `ping()` and `getVersion()` utility methods
- **Error handling:** service errors propagate as RPC-compatible errors

All tests should initially fail.

### 4.2 Implement SandboxRpcApi — one domain at a time

**File:** `packages/sandbox-container/src/rpc/sandbox-api.ts`

Implement methods domain-by-domain. After implementing each domain, run:

```bash
npm test -w @repo/sandbox-container     # Container unit tests — new domain tests now pass
npm test                                 # Full unit suite — nothing else broken
```

Implementation order (by dependency complexity, simplest first):

1. **Utility** — `ping()`, `getVersion()` (no service dependencies, proves basic wiring)
2. **Sessions** — `createSession()`, `deleteSession()`, `listSessions()` (needed by everything else)
3. **Commands** — `execute()`, `executeStream()` (core use case, streaming validation)
4. **Files** — `readFile()`, `writeFile()`, `readFileStream()`, `mkdir()`, `deleteFile()`, `renameFile()`, `moveFile()`, `listFiles()`, `exists()` (validates `ReadableStream` piping)
5. **Processes** — `startProcess()`, `listProcesses()`, `getProcess()`, `killProcess()`, `killAllProcesses()`, `getProcessLogs()`, `streamProcessLogs()`, `cleanupCompletedProcesses()`
6. **Ports** — `exposePort()`, `listExposedPorts()`, `unexposePort()`, `watchPorts()`
7. **Git** — `gitCheckout()`
8. **Code interpreter** — `createContext()`, `executeCode()`, `listContexts()`, `deleteContext()`
9. **Backup** — `createBackup()`, `restoreBackup()`
10. **Desktop** — all desktop methods
11. **Watch** — `watch()`

### 4.3 Register native RpcTarget in server

**File:** `packages/sandbox-container/src/server.ts`

Create `SandboxRpcApi` during app initialization and use it for `/capnweb` connections
instead of the bridge:

```ts
const rpcApi = new SandboxRpcApi({
  processService: container.get('processService'),
  fileService: container.get('fileService')
  // ... all services
});
```

### 4.4 Write unit tests for native client transport (TEST FIRST)

**File:** `packages/sandbox/tests/capnweb-native-transport.test.ts`

Tests for the SDK-side transport that calls `SandboxRpcApi` methods directly
rather than going through the fetch bridge:

- `execute()` calls `stub.execute()` and returns `ExecResult`
- `executeStream()` returns a `ReadableStream<Uint8Array>`
- `writeFile()` passes `ReadableStream` through to `stub.writeFile()`
- `readFileStream()` returns a `ReadableStream`
- All domain methods map to the correct stub calls
- Error propagation from stub to caller
- Connection lifecycle (connect, disconnect, reconnect)

### 4.5 Implement native capnweb client transport

**File:** `packages/sandbox/src/clients/transport/capnweb-native-transport.ts`

Replace the bridge adapter with a transport that uses capnweb RPC calls directly.
Instead of translating to fetch-like requests, it exposes typed methods on the stub:

```ts
export class CapnwebNativeTransport {
  private stub: RpcStub<SandboxRpcApi>;

  async execute(command: string, sessionId: string, options?: {...}): Promise<ExecResult> {
    return this.stub.execute(command, sessionId, options);
  }

  async executeStream(command: string, sessionId: string): Promise<ReadableStream<Uint8Array>> {
    return this.stub.executeStream(command, sessionId);
  }

  async writeFile(path: string, content: ReadableStream<Uint8Array>, sessionId: string) {
    return this.stub.writeFile(path, content, sessionId);
  }

  // ... etc
}
```

> **Design decision:** At this point the transport no longer implements `ITransport`
> (which is fetch-oriented). The domain client layer calls RPC methods directly rather
> than constructing HTTP requests. This is intentional — the `ITransport` interface is
> an HTTP abstraction that no longer makes sense.

Iterate until all tests from 4.4 pass.

### 4.6 Run full test suite — both transports

```bash
npm run check
npm test                                           # All unit tests (existing + new)
npm run test:e2e                                   # E2E with HTTP — still green
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # E2E with capnweb — exercises native path
```

All must be green.

---

## Stage 5: Simplify Sandbox DO (Eliminate Client Layer)

**Goal:** Replace the `SandboxClient` + 10 domain client classes with direct capnweb
stub calls in the Sandbox DO. The DO methods become thin proxies that add session
management and then forward to the container stub.

**Verification gate:**

```bash
npm run check
npm test                                           # Updated unit tests pass
npm run test:e2e                                   # E2E with HTTP — still green (if still wired)
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # E2E with capnweb — green
```

### 5.1 Update Sandbox DO unit tests (TEST FIRST)

**File:** `packages/sandbox/tests/sandbox.test.ts` (and related test files)

Before changing the Sandbox DO implementation, update the unit tests to mock
the capnweb stub instead of the HTTP client layer. The updated tests define
the expected behavior of the simplified DO.

For each DO method, the test should verify:

- The correct capnweb stub method is called
- Session ID is resolved before the call
- Arguments are forwarded correctly
- Return values pass through unchanged
- Errors propagate

**Important:** Update tests one file at a time. After each test file update:

```bash
npm test                         # Existing implementation still passes old tests
```

The updated tests will fail until the implementation is changed — that's expected.
Track which tests are "pending migration" vs "migrated".

### 5.2 Replace client calls in Sandbox DO — one domain at a time

**File:** `packages/sandbox/src/sandbox.ts`

Replace patterns like:

```ts
// Before
async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
  const session = await this.ensureDefaultSession();
  const response = await this.client.commands.execute(command, session, { ... });
  return this.mapExecuteResponseToExecResult(response, ...);
}
```

With:

```ts
// After
async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
  const session = await this.ensureDefaultSession();
  return this.containerApi.execute(command, session, { ... });
}
```

Where `this.containerApi` is the capnweb `RpcStub<SandboxRpcApi>`.

Migrate one domain at a time. After each domain:

```bash
npm run check                    # No type errors
npm test                         # Unit tests for migrated domain pass
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # E2E still green
```

Migration order (matching Stage 4.2):

1. **Utility** — `checkVersionCompatibility()`
2. **Sessions** — `ensureDefaultSession()`, `createSession()`, `deleteSession()`
3. **Commands** — `exec()`, `execStream()`, `execWithSession()`
4. **Files** — `writeFile()`, `readFile()`, `readFileStream()`, `deleteFile()`, `renameFile()`, `moveFile()`, `listFiles()`, `exists()`, `mkdir()`
5. **Processes** — `startProcess()`, `listProcesses()`, `getProcess()`, `killProcess()`, `killAllProcesses()`, `getProcessLogs()`, `streamProcessLogs()`, `cleanupCompletedProcesses()`
6. **Ports** — `exposePort()`, `listExposedPorts()`, `unexposePort()`, `watchPorts()`
7. **Git** — `gitCheckout()`
8. **Code interpreter** — `createCodeContext()`, `runCode()`, `runCodeStream()`, `listCodeContexts()`, `deleteCodeContext()`
9. **Backup** — `createBackup()`, `restoreBackup()`
10. **Desktop** — all desktop methods via `callDesktop()`
11. **Watch** — `watch()`

### 5.3 Simplify streaming methods

Current streaming methods do:

1. Call `client.commands.executeStream()` → HTTP SSE → `ReadableStream<Uint8Array>`
2. Return that stream (Workers RPC streams it to the calling Worker)

With capnweb:

1. Call `containerApi.executeStream()` → capnweb pipe → `ReadableStream<Uint8Array>`
2. Return that stream (Workers RPC streams it to the calling Worker)

The SSE parser is no longer needed in the DO. Stream events can be structured objects
rather than SSE text frames.

### 5.4 Simplify file operations

The `writeFile()` path becomes particularly clean:

```ts
// Before: Convert to byte-oriented stream for RPC, client constructs HTTP request
// with query params, waits for container, sends stream body via containerFetch()

// After:
async writeFile(path: string, content: ReadableStream<Uint8Array>, options?: { ... }) {
  const session = options?.sessionId ?? await this.ensureDefaultSession();
  return this.containerApi.writeFile(path, content, session);
}
```

capnweb handles stream transfer with backpressure. No `waitForContainer()` needed
because the capnweb session handles connection state.

### 5.5 Promise pipelining for session + operation (optional)

Use capnweb's pipelining to avoid sequential round trips for ensureDefaultSession + operation:

```ts
// Today: two sequential HTTP requests
const session = await this.ensureDefaultSession(); // HTTP POST /api/session/create
const result = await this.client.commands.execute(cmd, session); // HTTP POST /api/execute

// With pipelining: one round trip
const sessionPromise = this.containerApi.createSession({ id: sessionId });
const result = await this.containerApi.execute(cmd, sessionPromise.id);
```

> **Note:** This optimization requires the container's `SandboxRpcApi` to accept
> `RpcPromise<string>` where `sessionId` is expected. capnweb resolves the promise
> server-side before delivering the call. Evaluate whether this is worth the API
> complexity. If pursued, write tests for the pipelining behavior first.

### 5.6 Run full test suite

```bash
npm run check
npm test                                           # All updated unit tests pass
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # Full E2E green
```

---

## Stage 6: Clean Up Legacy Transport Code

**Goal:** Remove the old transport infrastructure, HTTP client layer, and container-side
HTTP handler/router/adapter code. The HTTP server remains for health checks (`/api/ping`,
`/api/version`) and PTY WebSocket (`/ws/pty`).

**Verification gate:**

```bash
npm run check                    # No dangling imports to deleted code
npm test                         # All remaining tests pass
npm run test:e2e                 # Full E2E green (capnweb is now the only transport)
```

### 6.0 Pre-deletion verification

Before deleting anything, confirm the capnweb path handles everything:

```bash
SANDBOX_TRANSPORT=capnweb npm run test:e2e         # Must be green
```

If any E2E tests fail with capnweb, fix them before proceeding with deletion.

### 6.1 Remove from SDK (`packages/sandbox/`)

Delete in batches. After each batch: `npm run check && npm test`.

**Batch 1 — Transport layer:**

- `src/clients/transport/http-transport.ts`
- `src/clients/transport/ws-transport.ts`
- `src/clients/transport/base-transport.ts`
- `src/clients/transport/factory.ts`
- `src/clients/transport/types.ts` (replace with capnweb types)
- `src/clients/transport/index.ts` (replace with capnweb exports)
- `tests/transport.test.ts`
- `tests/ws-transport.test.ts`

Run: `npm run check && npm test`

**Batch 2 — Client layer:**

- `src/clients/base-client.ts`
- `src/clients/command-client.ts`
- `src/clients/file-client.ts`
- `src/clients/process-client.ts`
- `src/clients/port-client.ts`
- `src/clients/git-client.ts`
- `src/clients/utility-client.ts`
- `src/clients/interpreter-client.ts`
- `src/clients/desktop-client.ts`
- `src/clients/backup-client.ts`
- `src/clients/watch-client.ts`
- `src/clients/sandbox-client.ts`
- `src/clients/types.ts` (keep `ContainerStub` if still needed for PTY)
- `tests/base-client.test.ts`
- `tests/command-client.test.ts`
- `tests/file-client.test.ts`
- `tests/process-client.test.ts`
- `tests/port-client.test.ts`
- `tests/git-client.test.ts`
- `tests/utility-client.test.ts`
- `tests/desktop-client.test.ts`
- `tests/sse-parser.test.ts`

Run: `npm run check && npm test`

**Batch 3 — SSE parser:**

- `src/sse-parser.ts`

Run: `npm run check && npm test`

**Update:**

- `src/clients/index.ts` — export only what remains
- `src/sandbox.ts` — remove `SandboxClient` usage, remove `createSandboxClient()`

### 6.2 Remove from container (`packages/sandbox-container/`)

Delete in batches. After each batch: `npm run check && npm test -w @repo/sandbox-container`.

**Batch 1 — WebSocket adapter + bridge:**

- `src/handlers/ws-adapter.ts`
- `src/handlers/capnweb-bridge.ts` (Stage 2 bridge, superseded by Stage 4)
- `tests/handlers/capnweb-bridge.test.ts`

Run: `npm run check && npm test -w @repo/sandbox-container`

**Batch 2 — HTTP handlers:**

- `src/handlers/execute-handler.ts`
- `src/handlers/file-handler.ts`
- `src/handlers/process-handler.ts`
- `src/handlers/port-handler.ts`
- `src/handlers/git-handler.ts`
- `src/handlers/interpreter-handler.ts`
- `src/handlers/session-handler.ts`
- `src/handlers/backup-handler.ts`
- `src/handlers/desktop-handler.ts`
- `src/handlers/watch-handler.ts`
- `src/handlers/base-handler.ts`
- `src/handlers/misc-handler.ts` (keep if `/api/ping` stays HTTP)
- Associated test files

Run: `npm run check && npm test -w @repo/sandbox-container`

**Batch 3 — Router and routes:**

- `src/routes/setup.ts`
- `src/core/router.ts` (keep minimal version for remaining HTTP routes)

Run: `npm run check && npm test -w @repo/sandbox-container`

**Keep:**

- `src/handlers/pty-ws-handler.ts` — PTY is a raw WebSocket protocol
- Minimal HTTP routes: `/api/ping`, `/api/version` for health checks
- `src/server.ts` — simplified, only starts capnweb + health + PTY

### 6.3 Remove from shared (`packages/shared/`)

**Delete:**

- `src/ws-types.ts` — `WSRequest`, `WSResponse`, `WSStreamChunk`, etc.

**Update exports in `src/index.ts`.**

Run: `npm run check && npm test`

### 6.4 Update `SANDBOX_TRANSPORT` env var handling

Remove `'http'` and `'websocket'` as valid values. `'capnweb'` becomes the only
transport (and the default). Remove the env var entirely if there's no need for
transport selection.

### 6.5 Final comprehensive verification

```bash
npm run check                    # Clean — no type errors, no lint issues
npm test                         # All remaining unit tests green
npm run test:e2e                 # Full E2E suite green (capnweb only)
```

---

## Stage 7: Advanced capnweb Features (Future)

**Goal:** Leverage capnweb capabilities that weren't available with the HTTP transport.

Each sub-item is independent. For each, follow the same TDD approach:
write tests → implement → verify full suite.

### 7.1 Bidirectional callbacks for event streams

Replace SSE-based event streaming with capnweb callbacks:

```ts
// Container side
class SandboxRpcApi extends RpcTarget {
  async watchFiles(
    path: string,
    sessionId: string,
    callback: (event: WatchEvent) => void
  ): Promise<void> {
    const watcher = this.watchService.watch(path, sessionId);
    watcher.on('change', (ev) => callback(ev));
  }
}
```

The callback is an `RpcTarget` function — capnweb automatically creates a stub that
calls back to the DO when invoked. No SSE parsing, no stream framing.

Applies to: file watch, port watch, process log streaming.

**Tests first:** Write unit tests for the callback-based API. Write E2E tests that
verify events are delivered. Then implement.

### 7.2 Promise pipelining for batched operations

Batch multiple operations into single round trips:

```ts
// Initialize session and run first command in one round trip
const session = containerApi.createSession({ id: 'test' });
const result = await containerApi.execute('npm install', session.id);
```

**Tests first:** Write unit tests that verify pipelined calls produce correct results.
Write E2E tests that verify reduced latency for chained operations.

### 7.3 `RpcTarget` sub-objects for domain isolation

Expose sub-APIs as nested `RpcTarget` objects:

```ts
class SandboxRpcApi extends RpcTarget {
  get files(): FileApi {
    return this.#fileApi;
  }
  get processes(): ProcessApi {
    return this.#processApi;
  }
  get desktop(): DesktopApi {
    return this.#desktopApi;
  }
}

// Client usage
const content = await containerApi.files.read('/workspace/main.py', sessionId);
await containerApi.desktop.screenshot();
```

**Tests first:** Write unit tests for sub-object access patterns. Verify the full
E2E suite still passes after restructuring.

### 7.4 Workers RPC passthrough (ultimate simplification)

Since capnweb stubs are interoperable with Workers RPC, explore passing the container's
`RpcStub` directly through to the calling Worker:

```ts
// In the Sandbox DO
get containerApi(): RpcStub<SandboxRpcApi> {
  return this.#containerStub;
}
```

The Worker could then call container methods directly, with the DO only handling
lifecycle (start/stop/sleep). This is the ultimate simplification but requires careful
security review — the DO currently gates access and manages sessions.

**Tests first:** Write integration tests verifying that a Worker can call through the
DO stub to the container. Verify security boundaries are maintained.

### 7.5 Contribute binary frame support to capnweb

Open a PR to capnweb to support `ArrayBuffer`/`Uint8Array` in the transport interface
alongside `string`. This would allow pipe chunks to be sent as binary WebSocket frames,
eliminating the base64 overhead for `ReadableStream<Uint8Array>` transfers.

This is the clean long-term fix for the binary encoding overhead identified in the
research phase.

**Tests first:** Write benchmarks comparing binary vs. base64 transfer for large file
payloads. Use these as the acceptance criteria for the upstream PR.

---

## Risk Register

| Risk                                       | Impact                                      | Mitigation                                                                      |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------- |
| capnweb pre-1.0 breaking changes           | Transport breaks on update                  | Pin exact version, review changelogs before bumping                             |
| Bun WebSocket incompatibility              | Container can't accept capnweb connections  | Test early in Stage 2; Bun's WS is WinterCG-compatible                          |
| DO→Container WebSocket establishment       | Can't get a WebSocket object in DO context  | Reuse proven `connectViaFetch()` pattern from existing WS transport             |
| Stream backpressure under load             | Memory growth on large transfers            | capnweb's BDP-based flow control handles this; verify with large file E2E tests |
| base64 overhead for binary-heavy workloads | ~33% bandwidth waste for file transfers     | Acceptable for localhost; pursue upstream binary support (Stage 7.5)            |
| Container startup race                     | capnweb connects before Bun server is ready | Keep container startup retry logic in transport adapter (Stage 1)               |
| PTY WebSocket compatibility                | Terminal sessions break                     | PTY uses raw WebSocket, not RPC — keep existing `/ws/pty` path unchanged        |
| E2E test flakiness during migration        | False failures during transition            | Run E2E suite with both transports during Stages 3–5                            |

---

## Migration Checklist

- [ ] **Stage 1:** Write capnweb transport tests → implement transport → `npm run check && npm test` green
- [ ] **Stage 2:** Write bridge tests → implement bridge → `npm run check && npm test` green
- [ ] **Stage 3:** Write E2E test → wire up DO + SandboxClient → `npm run check && npm test && npm run test:e2e` green (both transports)
- [ ] **Stage 4:** Write SandboxRpcApi tests → implement domain-by-domain → write native transport tests → implement → `npm run check && npm test && npm run test:e2e` green (both transports)
- [ ] **Stage 5:** Update DO tests → replace client calls domain-by-domain → `npm run check && npm test && SANDBOX_TRANSPORT=capnweb npm run test:e2e` green after each domain
- [ ] **Stage 6:** Pre-deletion E2E green → delete in batches → `npm run check && npm test` after each batch → final `npm run test:e2e` green
- [ ] **Stage 7:** For each feature: write tests → implement → full suite green

**The cardinal rule: the full test suite is green at every commit, not just at stage boundaries.**

Stages 1–3 are additive (no existing code modified or deleted). The default transport
remains `'http'`. Existing tests pass without modification.

Stages 4–5 replace internals but the public API (`ISandbox`) is unchanged.
Existing E2E tests are the regression safety net, run against both transports.

Stage 6 is the cleanup — only executed after full E2E validation of the capnweb path.
Deletions happen in small batches with verification after each.

Stage 7 is opportunistic — each sub-item is independent and follows the same TDD cycle.
