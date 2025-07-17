# Preview URLs & Port Management - Implementation Plan

## Overview

Add simple port exposure functionality to the Cloudflare Sandbox SDK, allowing developers to explicitly expose container ports and access them via public preview URLs.

## Core Design Principles

- **Explicit over implicit**: Developers must explicitly expose ports
- **Simple URLs**: Clean, predictable URL structure
- **Public by default**: No authentication complexity
- **Minimal API surface**: Just expose, unexpose, and list

## API Design

### New Sandbox Methods

```typescript
// Expose a port and get a preview URL
await sandbox.exposePort(3000, { name: "web-app" }); 
// Returns: { url: "https://3000-sandbox-abc123.workers.dev", port: 3000, name: "web-app" }

// Unexpose a port
await sandbox.unexposePort(3000);

// List all exposed ports
await sandbox.getExposedPorts();
// Returns: [{ url: "...", port: 3000, name: "web-app" }, ...]
```

### URL Structure

```
https://{port}-{sandbox-id}.{worker-subdomain}.workers.dev
```

Example: `https://3000-sandbox-abc123.workers.dev`

## Implementation Plan

### Phase 1: Container-Side Changes

1. **Add new endpoints to command server** (`packages/sandbox/container_src/index.ts`):
   - `POST /expose-port` - Register a port as exposed
   - `DELETE /expose-port/{port}` - Unexpose a port
   - `GET /exposed-ports` - List exposed ports
   - `GET /proxy/{port}/*` - Proxy requests to localhost:{port}

2. **Track exposed ports in memory**:
   - Simple Map or Set to track which ports are exposed
   - Clear on container restart

### Phase 2: Sandbox Class Updates

1. **Add new methods** (`packages/sandbox/src/index.ts`):
   ```typescript
   async exposePort(port: number, options?: { name?: string }): Promise<PreviewInfo>
   async unexposePort(port: number): Promise<void>
   async getExposedPorts(): Promise<ExposedPort[]>
   ```

2. **Add TypeScript interfaces** (`packages/sandbox/src/client.ts`):
   ```typescript
   interface PreviewInfo {
     url: string;
     port: number;
     name?: string;
   }
   
   interface ExposedPort extends PreviewInfo {
     exposedAt: string;
   }
   ```

### Phase 3: Worker Routing

1. **Update main worker** to handle preview URL patterns:
   - Parse subdomain for `{port}-{sandbox-id}` pattern
   - Route to appropriate Durable Object
   - Forward request to container's proxy endpoint

2. **Request flow**:
   ```
   Preview URL Request
   ↓
   Worker: Parse subdomain
   ↓
   Get Sandbox DO by ID
   ↓
   Check if port is exposed
   ↓
   Proxy to container:/proxy/{port}/*
   ```

### Phase 4: Error Handling

Handle these cases gracefully:
- Port not exposed → "Port 3000 is not exposed on this sandbox"
- Service not responding → "Service on port 3000 is not responding"
- Sandbox not found → "Sandbox not found"
- Invalid port number → "Invalid port number"

## File Changes Required

1. **Container command server**:
   - `packages/sandbox/container_src/index.ts` - Add new endpoints

2. **Sandbox class**:
   - `packages/sandbox/src/index.ts` - Add new methods
   - `packages/sandbox/src/client.ts` - Add interfaces

3. **Worker**:
   - `examples/basic/src/index.ts` - Add routing logic (or wherever the main worker is)

4. **Tests**:
   - Add tests for new functionality

## Usage Example

```typescript
// Start a web server in the sandbox
await sandbox.exec("python", ["-m", "http.server", "8080"]);

// Expose the port
const preview = await sandbox.exposePort(8080, { name: "docs-server" });
console.log(`Preview available at: ${preview.url}`);

// Later, unexpose if needed
await sandbox.unexposePort(8080);
```

## Out of Scope (For Now)

- Authentication/authorization
- WebSocket support
- HTTPS/TLS termination
- Port auto-detection
- Health checks
- Custom domains
- CORS configuration
- Connection pooling
- Request/response modification

## Success Criteria

1. Developers can expose a port with a single method call
2. Preview URLs work immediately after exposure
3. Clean error messages for common failures
4. No performance degradation for non-preview requests
5. Simple to understand and use

## Next Steps

1. Implement container-side endpoints
2. Add Sandbox class methods
3. Update Worker routing
4. Write tests
5. Update documentation
6. Gather feedback for v2 features (WebSockets, auth, etc.)