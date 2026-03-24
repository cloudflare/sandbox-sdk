# Capnweb Clean Separation Plan

## Problem

The current capnweb implementation is layered on top of the old HTTP transport
architecture. `CapnwebTransport` extends `BaseTransport`, implements `ITransport`
(a fetch-oriented interface), and goes through `SandboxClient` → 10 domain clients
→ `ITransport.fetch()`. This makes it impossible to delete the old code because
capnweb still depends on the same abstractions.

## Goal

Create a standalone capnweb connection layer that the Sandbox DO uses directly,
so the entire old transport/client/handler stack can be deleted. The **only thing
that stays the same** is the public Worker-facing interface (`ISandbox`,
`ExecutionSession`, `getSandbox`, etc.).

## Architecture: Before → After

**Before (current):**

```
Sandbox DO
  → this.client (SandboxClient)
    → this.client.files (FileClient)
      → this.transport.fetch('/api/write', ...)  ← ITransport
        → CapnwebTransport.doFetch()
          → stub.fetch('POST', '/api/write', body)  ← bridge RPC
            → ContainerBridgeAPI.fetch()
              → Router.route()
                → FileHandler.handleWrite()
                  → FileService.write()
```

**After (target):**

```
Sandbox DO
  → this.container.writeFile(path, content, session)  ← typed stub
    → capnweb RPC pipe
      → SandboxRPCAPI.writeFile()
        → FileService.write()
```

The entire middle layer (SandboxClient, 10 domain clients, ITransport,
BaseTransport, HttpTransport, WebSocketTransport, CapnwebTransport,
ContainerBridgeAPI, Router, 14 HTTP handlers, WebSocketAdapter, SSE parser)
becomes deletable.

## New Files

### SDK side (`packages/sandbox/src/`)

**`container-connection.ts`** (~200 lines)

A single class that manages the capnweb WebSocket lifecycle and exposes
typed RPC methods. This replaces `SandboxClient` + all domain clients +
all transports.

```ts
import { newWebSocketRpcSession, type RpcStub } from 'capnweb';

/**
 * Typed interface matching the container's SandboxRPCAPI methods.
 * Each method maps 1:1 to a method on the container's RpcTarget.
 */
export interface ContainerRPCAPI {
  ping(): Promise<{ status: string; timestamp: string }>;
  getVersion(): Promise<{ version: string; timestamp: string }>;

  createSession(options: { id: string; env?: Record<string, string | undefined>; cwd?: string }): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string): Promise<{ success: boolean; sessionId: string }>;
  listSessions(): Promise<{ sessions: string[] }>;

  execute(command: string, sessionId: string, options?: { timeoutMs?: number; env?: Record<string, string | undefined>; cwd?: string }): Promise<ExecuteResult>;
  executeStream(command: string, sessionId: string, options?: { ... }): Promise<ReadableStream<Uint8Array>>;

  writeFile(path: string, content: string, sessionId: string, options?: { ... }): Promise<WriteFileResult>;
  writeFileStream(path: string, stream: ReadableStream<Uint8Array>, sessionId: string): Promise<WriteFileResult>;
  readFile(path: string, sessionId: string, options?: { ... }): Promise<ReadFileResult>;
  readFileStream(path: string, sessionId: string): Promise<ReadableStream<Uint8Array>>;
  deleteFile(path: string, sessionId: string): Promise<...>;
  renameFile(oldPath: string, newPath: string, sessionId: string): Promise<...>;
  moveFile(sourcePath: string, destinationPath: string, sessionId: string): Promise<...>;
  mkdir(path: string, sessionId: string, options?: { recursive?: boolean }): Promise<...>;
  listFiles(path: string, sessionId: string, options?: ListFilesOptions): Promise<...>;
  exists(path: string, sessionId: string): Promise<...>;

  startProcess(command: string, sessionId: string, options?: { ... }): Promise<...>;
  listProcesses(): Promise<...>;
  getProcess(id: string): Promise<...>;
  killProcess(id: string): Promise<void>;
  killAllProcesses(): Promise<number>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;

  exposePort(port: number, sessionId: string, name?: string): Promise<...>;
  listExposedPorts(): Promise<...>;
  unexposePort(port: number): Promise<void>;

  gitCheckout(repoUrl: string, sessionId: string, options?: { ... }): Promise<...>;

  createCodeContext(options?: { ... }): Promise<...>;
  executeCode(contextId: string, code: string, language?: string): Promise<Response>;
  listCodeContexts(): Promise<...>;
  deleteCodeContext(contextId: string): Promise<void>;

  createBackup(dir: string, archivePath: string, sessionId: string): Promise<unknown>;
  restoreBackup(dir: string, archivePath: string, sessionId: string): Promise<unknown>;

  desktopStart(request?: ...): Promise<...>;
  desktopStop(): Promise<...>;
  desktopStatus(): Promise<...>;
  // ... all desktop methods

  watch(path: string, sessionId: string, options?: { ... }): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Manages a capnweb WebSocket connection to the container.
 * The Sandbox DO holds one of these and calls methods directly.
 */
export class ContainerConnection {
  private stub: RpcStub<ContainerRPCAPI> | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private containerStub: ContainerStub,
    private port: number = 3000,
    private logger: Logger
  ) {}

  /** Establish capnweb session via WebSocket upgrade through the DO's Container base class */
  async connect(): Promise<void> { ... }

  /** Dispose the session and close the WebSocket */
  disconnect(): void { ... }

  /** Whether the session is active */
  isConnected(): boolean { ... }

  /**
   * Get the typed RPC stub. Connects on first access.
   * All Sandbox DO methods call through this.
   */
  async api(): Promise<RpcStub<ContainerRPCAPI>> {
    if (!this.isConnected()) await this.connect();
    return this.stub!;
  }
}
```

The connection logic is extracted from the current `CapnwebTransport.connectViaFetch()` —
it's ~50 lines.

### Container side

**No new files needed.** `SandboxRPCAPI` already exists and covers all domains.
The bridge (`ContainerBridgeAPI`) becomes deletable since the SDK no longer
goes through fetch-like calls.

## Changes to `sandbox.ts`

Replace `this.client` (SandboxClient) with `this.container` (ContainerConnection).
Each method becomes a thin proxy:

```ts
// Before (current):
async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
  const session = await this.ensureDefaultSession();
  return this.execWithSession(command, session, options);
}
private async execWithSession(command, sessionId, options) {
  // ... 80 lines of timeout handling, streaming detection, response mapping
  const response = await this.client.commands.execute(command, sessionId, { ... });
  return this.mapExecuteResponseToExecResult(response, duration, sessionId);
}

// After:
async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
  const session = await this.ensureDefaultSession();
  const api = await this.container.api();
  const result = await api.execute(command, session, {
    timeoutMs: options?.timeout,
    env: options?.env,
    cwd: options?.cwd,
  });
  return {
    ...result,
    duration: 0,
    sessionId: session,
  };
}
```

The response mapping disappears because `SandboxRPCAPI` already returns the
correct shapes. The 80-line `execWithSession` collapses to ~10 lines.

### Migration approach for sandbox.ts

Replace `this.client.*` calls one domain at a time, keeping the public API
(`ISandbox`) unchanged:

1. Add `private container: ContainerConnection` field
2. Initialize it in `onStart()` (where `this.client` is currently created)
3. Replace calls domain by domain (commands → files → processes → etc.)
4. After all calls are migrated, remove `this.client` field and `SandboxClient` import
5. Remove `createSandboxClient()` method

Each step: `npm run check && npm test && npm run test:e2e`

## Files to Delete After Migration

### SDK (`packages/sandbox/`) — ~4500 lines

| File                                         | Lines | Why deletable                             |
| -------------------------------------------- | ----- | ----------------------------------------- |
| `src/clients/transport/base-transport.ts`    | ~100  | No ITransport needed                      |
| `src/clients/transport/http-transport.ts`    | ~80   | HTTP transport gone                       |
| `src/clients/transport/ws-transport.ts`      | ~450  | WebSocket transport gone                  |
| `src/clients/transport/capnweb-transport.ts` | ~310  | Replaced by ContainerConnection           |
| `src/clients/transport/factory.ts`           | ~40   | No transport factory needed               |
| `src/clients/transport/types.ts`             | ~80   | ITransport interface gone                 |
| `src/clients/transport/index.ts`             | ~30   | Re-exports gone                           |
| `src/clients/base-client.ts`                 | ~200  | No HTTP client base needed                |
| `src/clients/command-client.ts`              | ~150  | Direct RPC calls                          |
| `src/clients/file-client.ts`                 | ~250  | Direct RPC calls                          |
| `src/clients/process-client.ts`              | ~200  | Direct RPC calls                          |
| `src/clients/port-client.ts`                 | ~200  | Direct RPC calls                          |
| `src/clients/git-client.ts`                  | ~100  | Direct RPC calls                          |
| `src/clients/utility-client.ts`              | ~200  | Direct RPC calls                          |
| `src/clients/interpreter-client.ts`          | ~200  | Direct RPC calls                          |
| `src/clients/backup-client.ts`               | ~100  | Direct RPC calls                          |
| `src/clients/desktop-client.ts`              | ~350  | Direct RPC calls                          |
| `src/clients/watch-client.ts`                | ~100  | Direct RPC calls                          |
| `src/clients/sandbox-client.ts`              | ~150  | Replaced by ContainerConnection           |
| `src/clients/types.ts`                       | ~100  | Keep only ContainerStub                   |
| `src/clients/index.ts`                       | ~100  | Minimal re-exports                        |
| `src/sse-parser.ts`                          | ~130  | SSE parsing gone (RPC returns typed data) |
| `tests/transport.test.ts`                    | -     | Old transport tests                       |
| `tests/ws-transport.test.ts`                 | -     | Old WS transport tests                    |
| `tests/capnweb-transport.test.ts`            | -     | Old capnweb transport tests               |
| `tests/base-client.test.ts`                  | -     | Old client tests                          |
| `tests/command-client.test.ts`               | -     | Old client tests                          |
| `tests/file-client.test.ts`                  | -     | Old client tests                          |
| `tests/process-client.test.ts`               | -     | Old client tests                          |
| `tests/port-client.test.ts`                  | -     | Old client tests                          |
| `tests/git-client.test.ts`                   | -     | Old client tests                          |
| `tests/utility-client.test.ts`               | -     | Old client tests                          |
| `tests/desktop-client.test.ts`               | -     | Old client tests                          |
| `tests/sse-parser.test.ts`                   | -     | Old SSE parser tests                      |

### Container (`packages/sandbox-container/`) — ~4000 lines

| File                                  | Lines | Why deletable                   |
| ------------------------------------- | ----- | ------------------------------- |
| `src/handlers/ws-adapter.ts`          | ~450  | No WebSocket adapter needed     |
| `src/handlers/capnweb-bridge.ts`      | ~70   | Bridge superseded by native RPC |
| `src/handlers/execute-handler.ts`     | ~250  | RPC calls services directly     |
| `src/handlers/file-handler.ts`        | ~350  | RPC calls services directly     |
| `src/handlers/process-handler.ts`     | ~250  | RPC calls services directly     |
| `src/handlers/port-handler.ts`        | ~300  | RPC calls services directly     |
| `src/handlers/git-handler.ts`         | ~100  | RPC calls services directly     |
| `src/handlers/interpreter-handler.ts` | ~200  | RPC calls services directly     |
| `src/handlers/session-handler.ts`     | ~150  | RPC calls services directly     |
| `src/handlers/backup-handler.ts`      | ~200  | RPC calls services directly     |
| `src/handlers/desktop-handler.ts`     | ~250  | RPC calls services directly     |
| `src/handlers/watch-handler.ts`       | ~100  | RPC calls services directly     |
| `src/handlers/base-handler.ts`        | ~150  | HTTP handler base gone          |
| `src/routes/setup.ts`                 | ~100  | No HTTP routing needed          |
| `src/core/router.ts`                  | ~250  | No HTTP router needed           |
| Associated test files                 | ~2000 | Tests for deleted handlers      |

**Keep:**

- `src/handlers/misc-handler.ts` — health check `/api/ping`, `/api/version` (minimal HTTP)
- `src/handlers/pty-ws-handler.ts` — PTY uses raw WebSocket, not RPC
- `src/handlers/bun-ws-shim.ts` — Still needed for capnweb ↔ Bun WebSocket
- `src/rpc/sandbox-api.ts` — The native RPC API
- `src/services/*` — All services stay (they're the business logic)
- `src/server.ts` — Simplified: capnweb + health check + PTY only

### Shared (`packages/shared/`)

| File              | Why deletable                                       |
| ----------------- | --------------------------------------------------- |
| `src/ws-types.ts` | WSRequest, WSResponse, WSStreamChunk no longer used |

## Execution Order

### Phase 1: Create ContainerConnection (~200 lines new code)

1. Write `src/container-connection.ts` with the `ContainerRPCAPI` interface
   and `ContainerConnection` class
2. Write tests for it
3. `npm run check && npm test`

### Phase 2: Migrate sandbox.ts (modify ~200 lines, simplify ~500 lines)

1. Add `private container: ContainerConnection` to Sandbox
2. Initialize in `onStart()` alongside `this.client`
3. Replace `this.client.*` calls one domain at a time:
   - Each domain: update calls → `npm run check && npm test`
   - Order: utility → sessions → commands → files → processes → ports → git → interpreter → backup → desktop → watch
4. Remove `this.client` field and `createSandboxClient()`
5. `npm run check && npm test`
6. **Pause for E2E tests**

### Phase 3: Delete SDK legacy code (~4500 lines deleted)

1. Delete transport layer files (batch)
2. Delete domain client files (batch)
3. Delete SSE parser
4. Update `src/clients/index.ts` to export only what remains
5. Delete old test files
6. After each batch: `npm run check && npm test`

### Phase 4: Delete container legacy code (~4000 lines deleted)

1. Delete HTTP handlers (batch)
2. Delete WebSocket adapter + bridge
3. Delete router + routes
4. Simplify `server.ts` to only capnweb + health + PTY
5. Delete handler test files
6. After each batch: `npm run check && npm test`
7. **Pause for E2E tests**

### Phase 5: Clean up shared types

1. Delete `ws-types.ts`
2. Remove `SANDBOX_TRANSPORT` env var handling (capnweb is the only transport)
3. Update exports
4. `npm run check && npm test`

## Net Effect

|                               | Before      | After       | Delta     |
| ----------------------------- | ----------- | ----------- | --------- |
| SDK transport/client code     | ~4500 lines | ~200 lines  | **-4300** |
| Container handler/router code | ~4000 lines | ~0 lines    | **-4000** |
| Container RPC API             | ~900 lines  | ~900 lines  | 0         |
| Total                         | ~9400 lines | ~1100 lines | **-8300** |

The public API (`ISandbox`, `ExecutionSession`, `getSandbox`, `streamFile`,
`collectFile`, `proxyToSandbox`, etc.) is completely unchanged.
