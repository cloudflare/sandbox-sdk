# Multi-Port Support Implementation Plan

## Overview

This document outlines the plan to implement proper multi-port support in the Cloudflare Sandbox SDK. The current architecture has a limitation where all traffic is proxied through port 3000, but Cloudflare Containers expects to be able to health check and connect directly to exposed ports.

## Current Architecture (Problem)

```
User Request → Preview URL (/preview/8080/...) → Container Port 3000 → Proxy to Port 8080
                                                           ↑
                                                  Cloudflare tries to 
                                                  health check port 8080
                                                  directly (FAILS)
```

- Single entry point on port 3000
- All requests proxied through `/proxy/{port}/*` endpoints
- Cloudflare health checks fail because port 8080 isn't actually exposed at the container level

## Proposed Architecture (Solution)

```
User Request → Preview URL (/preview/8080/...) → Container Port 8080 (Direct)
                                                           ↑
                                                  Cloudflare health check
                                                  succeeds

Control Plane APIs → Container Port 3000 (Direct)
```

**Key Design Principles:**
1. **Port-based routing**: The port number in the preview URL determines where to route
2. **Port 3000 is special**: Reserved for the control plane (SDK's built-in server)
3. **No endpoint lists**: Avoid maintaining lists of API endpoints
4. **Simple mental model**: Port 3000 = SDK APIs, Other ports = User services

## Implementation Steps

### 1. Update Sandbox Class (`packages/sandbox/src/sandbox.ts`)

Remove the hardcoded `defaultPort`:

```typescript
export class Sandbox<Env = unknown> extends Container<Env> {
  // Remove: defaultPort = 3000;
  
  // Add custom fetch routing
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Determine which port to route to
    const port = this.determinePort(url);
    
    // Route to the appropriate port
    return await this.containerFetch(request, port);
  }
  
  private determinePort(url: URL): number {
    // Extract port from the request itself if present
    // This happens when handleSandboxRequest creates a proxy URL
    const proxyMatch = url.pathname.match(/^\/proxy\/(\d+)/);
    if (proxyMatch) {
      return parseInt(proxyMatch[1]);
    }
    
    // All other requests go to control plane on port 3000
    // This includes /api/* endpoints and any other control requests
    return 3000;
  }
}
```

### 2. Update Request Handler (`packages/sandbox/src/request-handler.ts`)

The key insight is that the request handler already knows which port the user wants based on the preview URL. We can use this to make smarter routing decisions:

```typescript
// For preview URLs targeting specific ports (e.g., /preview/8080/...)
if (port !== 3000) {
  // Route directly to the user's service
  const proxyUrl = `http://localhost:${port}${path}${url.search}`;
  return sandbox.containerFetch(proxyRequest, port);
} else {
  // Port 3000 is our control plane - route normally
  const proxyUrl = `http://localhost:3000${path}${url.search}`;
  return sandbox.containerFetch(proxyRequest, 3000);
}
```

This approach:
- Doesn't require maintaining a list of endpoints
- Uses the port from the preview URL as the source of truth
- Treats port 3000 as special (control plane)
- Routes all other ports directly to user services

### 3. Container Server Updates (`packages/sandbox/container_src/index.ts`)

The container server on port 3000 should continue to handle:
- Control plane APIs (`/api/*`)
- Health checks
- Session management

User servers will run on their own ports and handle their own requests directly.

### 4. Port Management

When a user wants to expose a port:

```typescript
// User writes a server file
await sandbox.writeFile("server.js", `
  Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("Hello from port 8080!");
    }
  });
`);

// Start the server
await sandbox.exec("bun", ["server.js"], { background: true });

// The port is automatically accessible via preview URLs
// No need to explicitly "expose" it to Cloudflare
```

## Key Considerations

### 1. Health Checks
- Cloudflare will health check the port specified in the preview URL
- The user's server must be running and responding on that port
- We may need to implement a wait mechanism to ensure the server is ready

### 2. Port Conflicts
- The control plane uses port 3000
- User applications should avoid port 3000
- We should document reserved ports

### 3. Security
- Each port should only be accessible through proper preview URLs
- The control plane (port 3000) should validate all requests

### 4. Backwards Compatibility
- Existing code that writes to files and executes commands will continue to work
- The `/api/*` endpoints remain on port 3000
- Only the port routing mechanism changes

## Examples

### Example 1: Simple Web Server

```typescript
// User creates a web server on port 8080
const sandbox = getSandbox(env.Sandbox, "my-webapp");

await sandbox.writeFile("app.js", `
  Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("My Web App", {
        headers: { "Content-Type": "text/html" }
      });
    }
  });
`);

await sandbox.exec("bun", ["app.js"], { background: true });

// Preview URL: /preview/8080/{sandboxId}/
// This routes directly to port 8080
```

### Example 2: Multiple Services

```typescript
// API server on port 3001 (avoiding 3000)
await sandbox.writeFile("api.js", `
  Bun.serve({
    port: 3001,
    fetch(req) {
      return new Response(JSON.stringify({ api: "v1" }));
    }
  });
`);

// Static file server on port 8080
await sandbox.writeFile("static.js", `
  Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("Static content");
    }
  });
`);

// Start both services
await sandbox.exec("bun", ["api.js"], { background: true });
await sandbox.exec("bun", ["static.js"], { background: true });

// Preview URLs:
// - /preview/3001/{sandboxId}/ → API server
// - /preview/8080/{sandboxId}/ → Static server
```

### Example 3: Control Plane Usage

```typescript
// Control plane operations still work the same way
await sandbox.writeFile("data.json", JSON.stringify({ foo: "bar" }));
const result = await sandbox.exec("ls", ["-la"]);

// These use the control plane on port 3000 internally
```

## Testing Strategy

1. **Unit Tests**
   - Test port routing logic
   - Test control plane endpoint detection
   - Test preview URL parsing

2. **Integration Tests**
   - Start a server on a custom port
   - Access it via preview URL
   - Verify Cloudflare health checks pass

3. **Multi-Port Tests**
   - Run multiple services on different ports
   - Verify each is independently accessible
   - Ensure control plane remains functional

## Migration Checklist

- [ ] Remove `defaultPort = 3000` from Sandbox class
- [ ] Implement custom `fetch()` method with port routing
- [ ] Update request handler to route directly to target ports
- [ ] Test health checks work on custom ports
- [ ] Update documentation with examples
- [ ] Add port conflict warnings for port 3000
- [ ] Test backwards compatibility with existing code
- [ ] Add integration tests for multi-port scenarios

## Reserved Ports

The following ports are reserved and should not be used by user applications:

- **Port 3000**: Control plane API (file operations, command execution, etc.)

## Future Enhancements

1. **Port Auto-Discovery**: Automatically detect which ports user applications are listening on
2. **Port Aliasing**: Allow friendly names for ports (e.g., "api" → 3001)
3. **Built-in Reverse Proxy**: For complex routing scenarios
4. **Port Range Restrictions**: Configurable allowed port ranges for security