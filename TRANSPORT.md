# Transport Layer Refactoring Plan

> **Status: COMPLETED** - This refactoring has been implemented. The document below describes the architecture.

This document outlines the transport layer architecture for the SDK.

---

## Current Problems

### 1. Asymmetric File Structure

- `ws-transport.ts` is a dedicated 550-line class
- HTTP transport is ~50 lines of inline code scattered in `transport.ts`
- No clear interface defining what a transport must implement

### 2. Mixed Concerns in Transport Class

The current `Transport` class handles:

- Mode switching (`if websocket ... else http`)
- Retry logic for 503 errors
- HTTP fetch implementation
- WebSocket-to-Response conversion
- Connection lifecycle management

### 3. Misleading Naming in Container

- `ws-handler.ts` sounds like a domain handler (like `file-handler.ts`, `process-handler.ts`)
- But it's actually a **protocol adapter** that bridges WebSocket to HTTP
- All other handlers are domain-specific; this one is protocol-specific

---

## Proposed Architecture

### SDK Transport Layer (`packages/sandbox/src/clients/transport/`)

```
transport/
├── types.ts              # Interfaces and shared types
├── base-transport.ts     # Abstract base with shared retry logic
├── http-transport.ts     # HTTP implementation
├── ws-transport.ts       # WebSocket implementation (moved from current location)
├── factory.ts            # createTransport() factory function
└── index.ts              # Public exports
```

### Container Protocol Layer (`packages/sandbox-container/src/`)

Rename `handlers/ws-handler.ts` → `protocol/ws-adapter.ts`

```
protocol/
└── ws-adapter.ts         # WebSocket-to-HTTP protocol adapter
```

Or alternatively, keep in handlers but rename:

```
handlers/
├── ws-adapter.ts         # Renamed from ws-handler.ts
├── file-handler.ts       # Domain handler
├── process-handler.ts    # Domain handler
└── ...
```

---

## Detailed Design

### 1. Transport Interface (`transport/types.ts`)

```typescript
/**
 * Transport mode for SDK communication
 */
export type TransportMode = 'http' | 'websocket';

/**
 * Configuration options for creating a transport
 */
export interface TransportConfig {
  /** Base URL for HTTP requests */
  baseUrl: string;

  /** WebSocket URL (required for WebSocket mode) */
  wsUrl?: string;

  /** Logger instance */
  logger?: Logger;

  /** Container stub for DO-internal requests */
  stub?: ContainerStub;

  /** Port number */
  port?: number;

  /** Request timeout in milliseconds */
  requestTimeoutMs?: number;
}

/**
 * Transport interface - all transports must implement this
 */
export interface ITransport {
  /**
   * Make a fetch-compatible request
   * @returns Standard Response object
   */
  fetch(path: string, options?: RequestInit): Promise<Response>;

  /**
   * Make a streaming request
   * @returns ReadableStream for consuming SSE/streaming data
   */
  fetchStream(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST'
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Get the transport mode
   */
  getMode(): TransportMode;

  /**
   * Connect the transport (no-op for HTTP)
   */
  connect(): Promise<void>;

  /**
   * Disconnect the transport (no-op for HTTP)
   */
  disconnect(): void;

  /**
   * Check if connected (always true for HTTP)
   */
  isConnected(): boolean;
}
```

### 2. Base Transport with Retry Logic (`transport/base-transport.ts`)

```typescript
/**
 * Abstract base transport with shared retry logic
 *
 * Handles 503 retry for container startup - shared by all transports.
 */
export abstract class BaseTransport implements ITransport {
  protected config: TransportConfig;
  protected logger: Logger;

  // Retry configuration
  private static readonly TIMEOUT_MS = 120_000;
  private static readonly MIN_TIME_FOR_RETRY_MS = 15_000;

  constructor(config: TransportConfig) {
    this.config = config;
    this.logger = config.logger ?? createNoOpLogger();
  }

  abstract getMode(): TransportMode;
  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract isConnected(): boolean;

  /**
   * Fetch with automatic retry for 503 (container starting)
   */
  async fetch(path: string, options?: RequestInit): Promise<Response> {
    const startTime = Date.now();
    let attempt = 0;

    while (true) {
      const response = await this.doFetch(path, options);

      if (response.status === 503) {
        const elapsed = Date.now() - startTime;
        const remaining = BaseTransport.TIMEOUT_MS - elapsed;

        if (remaining > BaseTransport.MIN_TIME_FOR_RETRY_MS) {
          const delay = Math.min(3000 * 2 ** attempt, 30000);
          this.logger.info('Container not ready, retrying', {
            attempt: attempt + 1,
            delayMs: delay,
            remainingSec: Math.floor(remaining / 1000)
          });
          await this.sleep(delay);
          attempt++;
          continue;
        }

        this.logger.error(
          'Container failed to become ready',
          new Error(`Failed after ${attempt + 1} attempts`)
        );
      }

      return response;
    }
  }

  /**
   * Transport-specific fetch implementation (no retry)
   */
  protected abstract doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response>;

  /**
   * Transport-specific stream implementation
   */
  abstract fetchStream(
    path: string,
    body?: unknown,
    method?: 'GET' | 'POST'
  ): Promise<ReadableStream<Uint8Array>>;

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### 3. HTTP Transport (`transport/http-transport.ts`)

```typescript
/**
 * HTTP transport implementation
 *
 * Uses standard fetch API for communication with the container.
 */
export class HttpTransport extends BaseTransport {
  getMode(): TransportMode {
    return 'http';
  }

  async connect(): Promise<void> {
    // No-op for HTTP - stateless protocol
  }

  disconnect(): void {
    // No-op for HTTP - stateless protocol
  }

  isConnected(): boolean {
    return true; // HTTP is always "connected"
  }

  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.buildUrl(path);

    if (this.config.stub) {
      return this.config.stub.containerFetch(
        url,
        options || {},
        this.config.port
      );
    }
    return globalThis.fetch(url, options);
  }

  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildUrl(path);
    const options = this.buildStreamOptions(body, method);

    let response: Response;
    if (this.config.stub) {
      response = await this.config.stub.containerFetch(
        url,
        options,
        this.config.port
      );
    } else {
      response = await globalThis.fetch(url, options);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }

  private buildUrl(path: string): string {
    if (this.config.stub) {
      return `http://localhost:${this.config.port}${path}`;
    }
    return `${this.config.baseUrl}${path}`;
  }

  private buildStreamOptions(
    body: unknown,
    method: 'GET' | 'POST'
  ): RequestInit {
    return {
      method,
      headers:
        body && method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    };
  }
}
```

### 4. WebSocket Transport (`transport/ws-transport.ts`)

Move and refactor the existing `ws-transport.ts`:

```typescript
/**
 * WebSocket transport implementation
 *
 * Multiplexes HTTP-like requests over a single WebSocket connection.
 * Useful when running inside Workers/DO where sub-request limits apply.
 */
export class WebSocketTransport extends BaseTransport {
  private ws: WebSocket | null = null;
  private state: 'disconnected' | 'connecting' | 'connected' | 'error' =
    'disconnected';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private connectPromise: Promise<void> | null = null;

  // ... existing WSTransport implementation, adapted to extend BaseTransport

  getMode(): TransportMode {
    return 'websocket';
  }

  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    await this.connect();

    const method = (options?.method || 'GET') as WSMethod;
    const body = this.parseBody(options?.body);

    const result = await this.request(method, path, body);

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ... rest of existing implementation
}
```

### 5. Factory Function (`transport/factory.ts`)

```typescript
/**
 * Create a transport instance based on mode
 */
export function createTransport(
  mode: TransportMode,
  config: TransportConfig
): ITransport {
  switch (mode) {
    case 'websocket':
      if (!config.wsUrl) {
        throw new Error('wsUrl is required for WebSocket transport');
      }
      return new WebSocketTransport(config);

    case 'http':
    default:
      return new HttpTransport(config);
  }
}
```

### 6. Public Exports (`transport/index.ts`)

```typescript
// Types
export type { ITransport, TransportConfig, TransportMode } from './types';

// Implementations (for advanced use cases)
export { HttpTransport } from './http-transport';
export { WebSocketTransport } from './ws-transport';
export { BaseTransport } from './base-transport';

// Factory (primary API)
export { createTransport } from './factory';
```

---

## Container-Side Rename

### Current: `handlers/ws-handler.ts`

**Problem**: The name suggests it's a domain handler like `file-handler.ts`, but it's actually a protocol adapter.

### Proposed: `protocol/ws-adapter.ts`

**Rationale**:

- Makes it clear this is protocol-level, not domain-level
- "Adapter" pattern accurately describes what it does (adapts WebSocket to HTTP)
- Separates protocol concerns from domain handlers

**Alternative**: Keep in `handlers/` but rename to `ws-adapter.ts`:

- Less file movement
- Still clarifies the role through naming
- Acceptable if we don't want a new `protocol/` directory for just one file

### Changes Required

1. Rename file: `ws-handler.ts` → `ws-adapter.ts`
2. Rename class: `WebSocketHandler` → `WebSocketAdapter`
3. Update imports in `server.ts`
4. Update test file name and imports

---

## Migration Steps (Completed)

All phases have been implemented:

- [x] **Phase 1**: Created `transport/` directory with `types.ts` (ITransport interface) and `base-transport.ts` (retry logic)
- [x] **Phase 2**: Implemented `http-transport.ts` extending BaseTransport
- [x] **Phase 3**: Migrated `ws-transport.ts` to extend BaseTransport (renamed to WebSocketTransport)
- [x] **Phase 4**: Updated `base-client.ts` and `sandbox-client.ts` to use ITransport interface
- [x] **Phase 5**: Renamed `ws-handler.ts` → `ws-adapter.ts`, class `WebSocketHandler` → `WebSocketAdapter`
- [x] **Phase 6**: Cleaned up old files, updated tests, verified all 518 tests pass

---

## Testing Strategy

### Unit Tests

- `http-transport.test.ts` - Test HTTP transport in isolation
- `ws-transport.test.ts` - Test WebSocket transport in isolation (existing tests, moved)
- `base-transport.test.ts` - Test retry logic
- `factory.test.ts` - Test factory creates correct types

### Integration Tests

- Existing E2E tests should continue to pass
- Both transport modes should be exercised

---

## Backwards Compatibility

### Breaking Changes

- `TransportResponse` type already removed (done)
- `request()` / `requestStream()` methods already removed (done)

### Non-Breaking

- `createTransport()` function signature remains the same
- `Transport` class behavior remains the same (just internal refactor)
- All public APIs preserved

---

## File Diff Summary

### New Files

```
packages/sandbox/src/clients/transport/
├── types.ts
├── base-transport.ts
├── http-transport.ts
├── ws-transport.ts      (moved from clients/)
├── factory.ts
└── index.ts
```

### Renamed Files

```
packages/sandbox-container/src/handlers/ws-handler.ts
  → packages/sandbox-container/src/handlers/ws-adapter.ts

packages/sandbox-container/tests/handlers/ws-handler.test.ts
  → packages/sandbox-container/tests/handlers/ws-adapter.test.ts
```

### Deleted Files

```
packages/sandbox/src/clients/transport.ts      (replaced by transport/)
packages/sandbox/src/clients/ws-transport.ts   (moved to transport/)
```

---

## Open Questions

1. **Directory structure for container adapter**:
   - Option A: `protocol/ws-adapter.ts` (new directory)
   - Option B: `handlers/ws-adapter.ts` (just rename)

   Recommendation: Option B (simpler, one file doesn't need its own directory)

2. **Should retry logic be a decorator instead of base class?**
   - Base class: Simpler, already working pattern
   - Decorator: More flexible, composable

   Recommendation: Base class (KISS principle, current approach works)

3. **Export individual transport classes or just the factory?**
   - Factory only: Simpler API surface
   - Include classes: Allows advanced use cases (testing, custom transports)

   Recommendation: Export both, but document factory as primary API
