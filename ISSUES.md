# WebSocket Transport - Architectural Issues

This document tracks architectural concerns identified in the WebSocket transport implementation that should be addressed before merging.

---

## Issue 1: Transport Abstraction Not Used for HTTP Mode ~~(Critical)~~ ✅ RESOLVED

**Location:** `packages/sandbox/src/clients/base-client.ts`

**Problem:** The `Transport` class was designed as a clean abstraction over HTTP and WebSocket, but `BaseHttpClient` only used it for WebSocket mode. HTTP requests bypassed the Transport entirely.

**Resolution:** Refactored BaseHttpClient to always use Transport:

```typescript
// BaseHttpClient now always creates a Transport
constructor(options: HttpClientOptions = {}) {
  if (options.transport) {
    this.transport = options.transport;
  } else {
    this.transport = createTransport({
      mode: options.transportMode ?? 'http',
      baseUrl: options.baseUrl,
      // ...
    });
  }
}

// All requests flow through Transport
protected async doFetch(path: string, options?: RequestInit): Promise<Response> {
  return this.transport.fetch(path, options);  // Always use Transport
}
```

---

## Issue 2: Duplicated Retry Logic ~~(High)~~ ✅ RESOLVED

**Location:** `packages/sandbox/src/clients/transport.ts`

**Problem:** The 503 retry logic for container startup existed in multiple places with duplicated code.

**Resolution:** Retry logic is now centralized in `Transport.fetch()`:

```typescript
async fetch(path: string, options?: RequestInit): Promise<Response> {
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    const response = await this.doFetch(path, options);

    if (response.status === 503) {
      const elapsed = Date.now() - startTime;
      const remaining = TIMEOUT_MS - elapsed;

      if (remaining > MIN_TIME_FOR_RETRY_MS) {
        const delay = Math.min(3000 * 2 ** attempt, 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
        continue;
      }
    }
    return response;
  }
}
```

Both HTTP and WebSocket modes now share this single implementation through `doFetch()`.

---

## Issue 3: Unnecessary Browser/Node WebSocket Path ~~(Medium)~~ ✅ RESOLVED (Keep)

**Location:** `packages/sandbox/src/clients/ws-transport.ts`

**Problem:** WSTransport has two connection methods:

- `connectViaFetch()` - Workers-style, uses containerFetch with upgrade headers
- `connectViaWebSocket()` - Standard `new WebSocket(url)` API

The SDK is designed to run inside Workers/Durable Objects. When would we use the standard WebSocket path?

**Analysis:**

- The browser/Node path is only used when `stub` is not provided
- In normal SDK usage, `stub` is always provided (it's the ContainerStub)
- Unit tests use the browser/Node path to test error handling and initial state
- Tests are designed to fail fast (short timeout) without establishing real connections

**Decision: Keep the browser/Node path**

Rationale:

1. **Enables unit testing** - Tests can verify timeout handling, disconnect safety, and error paths without requiring mock stubs
2. **Minimal maintenance cost** - The code is ~45 lines and well-tested
3. **Future flexibility** - Could theoretically support browser/Node clients if needed
4. **Removing would add complexity** - Would require creating mock ContainerStub implementations for tests

The path is documented as "browser/Node style" in comments, making its purpose clear.

---

## Issue 4: WebSocket Body Type Limitation ~~(Low)~~ ✅ RESOLVED (Documented)

**Location:** `packages/sandbox/src/clients/transport.ts:214-216`

**Problem:** WebSocket transport only supports string bodies, but `RequestInit.body` can be Blob, ArrayBuffer, FormData, etc.

**Status:** Already documented with clear error message:

```typescript
throw new Error(
  `WebSocket transport only supports string bodies. Got: ${typeof options.body}`
);
```

**Rationale for keeping:** The SDK is JSON-based - all operations use JSON serialization. Binary file uploads use base64 encoding which works with string bodies. The limitation is acceptable and clearly documented.

---

## Issue 5: Type Guards Only Validate Discriminator ~~(Low)~~ ✅ RESOLVED (Documented)

**Location:** `packages/shared/src/ws-types.ts`

**Problem:** Type guards only check the `type` field, not other required fields.

**Status:** Already documented with JSDoc comments on each type guard:

```typescript
/**
 * Type guard for WSResponse
 *
 * Note: Only validates the discriminator field (type === 'response').
 */
export function isWSResponse(msg: unknown): msg is WSResponse { ... }
```

**Rationale for keeping:** This is a deliberate trade-off:

- Full validation adds runtime cost for every message
- Type guards are used for routing; TypeScript ensures field validation after routing
- Documented in JSDoc comments for clarity

---

## Issue 6: Duplicate Fetch Methods in Transport ✅ RESOLVED (Cleaned Up)

**Location:** `packages/sandbox/src/clients/transport.ts`

**Problem:** Transport had two parallel APIs:

- **Primary API** (new): `fetch()` and `fetchStream()` - returns standard `Response` / `ReadableStream`
- **Legacy API** (old): `request()` and `requestStream()` - returns custom `TransportResponse`

This resulted in:

- `httpRequest()` and `doHttpFetch()` - similar but different return types
- `httpRequestStream()` and `doHttpStream()` - nearly identical HTTP streaming implementations
- `wsRequest()` wrapper for WebSocket - only used by deprecated `request()`

**Resolution:** Removed the legacy API entirely:

- Deleted `TransportResponse` type
- Deleted deprecated `request()` method
- Deleted `requestStream()` (was duplicate of `fetchStream()`)
- Deleted private helpers: `httpRequest()`, `httpRequestStream()`, `wsRequest()`
- Updated tests to use `fetch()` and `fetchStream()` instead

**Result:** Bundle size reduced by ~2.4 kB. Transport now has a single, clean API surface.

---

## Priority Order

1. **Issue 1** - Transport abstraction is the root cause of other issues
2. **Issue 2** - Duplicated code is a maintenance burden
3. **Issue 3** - Simplification opportunity
4. **Issue 4** - Document and defer
5. **Issue 5** - Already documented, acceptable trade-off

---

## Progress Tracking

- [x] Issue 1: Refactor to use Transport for all requests
  - BaseHttpClient now always creates a Transport (no longer optional)
  - `doFetch()` delegates to `this.transport.fetch()`
  - HTTP and WebSocket modes flow through the same abstraction
- [x] Issue 2: Extract shared retry logic
  - Retry logic moved to `Transport.fetch()` method
  - Both HTTP and WebSocket modes share the same retry implementation
  - Uses exponential backoff with 2-minute timeout budget
- [x] Issue 3: Decide on browser/Node path
  - Decision: Keep it for testability and flexibility
  - Code is minimal (~45 lines) and well-tested
- [x] Issue 4: Document limitation (already documented)
- [x] Issue 5: Keep as-is (already documented)
- [x] Issue 6: Clean up duplicate fetch methods
  - Removed legacy `request()` / `requestStream()` API
  - Removed `TransportResponse` type
  - Updated tests to use `fetch()` / `fetchStream()`
  - Bundle size reduced by ~2.4 kB
