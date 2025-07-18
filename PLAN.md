# Port Forwarding Simplification Plan

## Overview
This plan outlines how to simplify the port forwarding functionality in the Cloudflare Sandbox SDK, reducing user code from 40+ lines to just 3-5 lines for basic usage.

## Problem Statement
Currently, users must implement complex routing logic to handle preview URLs for port forwarding:
- Parse subdomain patterns for production environments
- Parse path patterns for localhost development
- Manually construct proxy URLs
- Handle request forwarding
- Manage different localhost variations (127.0.0.1, ::1, etc.)

## Solution Design

### Core Principle
The SDK should handle ALL preview URL routing internally. Users should only need to:
1. Import the handler function
2. Call it at the start of their fetch handler
3. Handle their custom routes

### Implementation Plan

#### 1. Create Request Handler Utilities (`packages/sandbox/src/request-handler.ts`)

```typescript
// New file with all routing logic
export interface SandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export interface RouteInfo {
  port: number;
  sandboxId: string;
  path: string;
}

export async function handleSandboxRequest<E extends SandboxEnv>(
  request: Request,
  env: E
): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    const routeInfo = extractSandboxRoute(url);
    
    if (!routeInfo) {
      return null; // Not a sandbox preview request
    }
    
    const { sandboxId, port, path } = routeInfo;
    const sandbox = getSandbox(env.Sandbox, sandboxId);
    
    // Build proxy request with proper headers
    const proxyUrl = `http://localhost:3000/proxy/${port}${path}${url.search}`;
    const proxyRequest = new Request(proxyUrl, {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers),
        'X-Original-URL': request.url,
        'X-Forwarded-Host': url.hostname,
        'X-Forwarded-Proto': url.protocol.replace(':', ''),
      },
      body: request.body,
    });
    
    return sandbox.containerFetch(proxyRequest);
  } catch (error) {
    console.error('[Sandbox] Preview URL routing error:', error);
    return new Response('Preview URL routing error', { status: 500 });
  }
}

function extractSandboxRoute(url: URL): RouteInfo | null {
  // Production: subdomain pattern {port}-{sandboxId}.{domain}
  const subdomainMatch = url.hostname.match(/^(\d+)-([a-zA-Z0-9-]+)\./);
  if (subdomainMatch) {
    return {
      port: parseInt(subdomainMatch[1]),
      sandboxId: subdomainMatch[2],
      path: url.pathname,
    };
  }
  
  // Development: path pattern /preview/{port}/{sandboxId}/*
  if (isLocalhostPattern(url.hostname)) {
    const pathMatch = url.pathname.match(/^\/preview\/(\d+)\/([^\/]+)(\/.*)?$/);
    if (pathMatch) {
      return {
        port: parseInt(pathMatch[1]),
        sandboxId: pathMatch[2],
        path: pathMatch[3] || "/",
      };
    }
  }
  
  return null;
}

function isLocalhostPattern(hostname: string): boolean {
  const hostPart = hostname.split(":")[0];
  return (
    hostPart === "localhost" ||
    hostPart === "127.0.0.1" ||
    hostPart === "::1" ||
    hostPart === "[::1]" ||
    hostPart === "0.0.0.0"
  );
}

// Convenience wrapper for simple use cases
export function createSandboxWorker<E extends SandboxEnv>(
  routeHandler?: (request: Request, env: E) => Promise<Response> | Response
) {
  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const sandboxResponse = await handleSandboxRequest(request, env);
      if (sandboxResponse) return sandboxResponse;
      
      if (routeHandler) {
        return routeHandler(request, env);
      }
      
      return new Response("Not found", { status: 404 });
    }
  };
}
```

#### 2. Update Main Index (`packages/sandbox/src/index.ts`)

```typescript
// Add exports
export { 
  handleSandboxRequest, 
  createSandboxWorker,
  type SandboxEnv,
  type RouteInfo 
} from './request-handler';

// Update isLocalhostPattern to be shared (or move to utils)
// Remove from Sandbox class and make it a utility function
```

#### 3. Simplify Example (`examples/basic/src/index.ts`)

Replace the entire 160-line file with:

```typescript
import { handleSandboxRequest, getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle all sandbox preview URLs automatically
    const sandboxResponse = await handleSandboxRequest(request, env);
    if (sandboxResponse) return sandboxResponse;
    
    // Custom routes
    const url = new URL(request.url);
    
    if (url.pathname === "/api") {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      return sandbox.containerFetch(request);
    }
    
    if (url.pathname === "/test-file") {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      await sandbox.writeFile("/test-file.txt", "Hello, world!" + Date.now());
      const file = await sandbox.readFile("/test-file.txt");
      return new Response(file!.content, { status: 200 });
    }
    
    if (url.pathname === "/test-preview") {
      const sandbox = getSandbox(env.Sandbox, "test-preview-sandbox");
      
      // Create and start a simple server
      await sandbox.writeFile("/server.js", `
        Bun.serve({
          port: 8080,
          fetch(req) {
            return new Response("Hello from Bun server! 🎉");
          },
        });
      `);
      
      await sandbox.exec("bun", ["run", "/server.js"]);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const preview = await sandbox.exposePort(8080, { name: "bun-server" });
      
      return new Response(JSON.stringify({
        message: "Server started and exposed",
        preview
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response("Not found", { status: 404 });
  },
};
```

#### 4. Update Documentation

##### README.md
Add a new section on port forwarding:

```markdown
## Port Forwarding

The SDK automatically handles preview URL routing for exposed ports. Just add one line to your worker:

```typescript
import { handleSandboxRequest, getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request, env) {
    // This handles all preview URL routing automatically
    const sandboxResponse = await handleSandboxRequest(request, env);
    if (sandboxResponse) return sandboxResponse;
    
    // Your custom routes here
    // ...
  }
};
```

When you expose a port, the SDK returns a preview URL that automatically routes to your service:

```typescript
const preview = await sandbox.exposePort(3000);
console.log(preview.url); // https://3000-sandbox-id.your-worker.dev
```

The SDK handles:
- Production subdomain routing (`3000-sandbox-id.domain.com`)
- Local development routing (`localhost:8787/preview/3000/sandbox-id`)
- All localhost variants (127.0.0.1, ::1, etc.)
- Request forwarding with proper headers
```

#### 5. Testing Strategy

Create comprehensive tests for the new routing logic:

```typescript
// packages/sandbox/tests/request-handler.test.ts
describe('handleSandboxRequest', () => {
  it('handles production subdomain pattern', async () => {
    const request = new Request('https://3000-my-sandbox.example.workers.dev/api/test');
    // Test routing extracts port=3000, sandboxId=my-sandbox, path=/api/test
  });
  
  it('handles localhost path pattern', async () => {
    const request = new Request('http://localhost:8787/preview/3000/my-sandbox/api/test');
    // Test routing extracts port=3000, sandboxId=my-sandbox, path=/api/test
  });
  
  it('handles all localhost variants', async () => {
    const variants = ['127.0.0.1', '::1', '[::1]', '0.0.0.0'];
    // Test each variant works correctly
  });
  
  it('returns null for non-preview URLs', async () => {
    const request = new Request('https://example.com/regular-route');
    const result = await handleSandboxRequest(request, mockEnv);
    expect(result).toBeNull();
  });
});
```

## Migration Path

Since we're not maintaining backward compatibility:

1. **Update all examples** to use the new pattern
2. **Update documentation** to only show the new approach
3. **Add deprecation notice** if keeping old pattern temporarily
4. **Version bump** to indicate breaking change (e.g., 0.x to 1.0)

## Benefits

1. **Simplicity**: 3-5 lines of code vs 40+ lines
2. **Zero configuration**: Works out of the box
3. **Future-proof**: Can add new routing patterns without user changes
4. **Type-safe**: Full TypeScript support
5. **Maintainable**: All routing logic in one place

## Timeline

1. **Phase 1**: Implement request handler utilities (1 day)
2. **Phase 2**: Update examples and tests (1 day)
3. **Phase 3**: Update documentation (0.5 day)
4. **Phase 4**: Release and communicate changes (0.5 day)

## Success Metrics

- User code reduced by 90%+ for basic use cases
- Zero routing-related issues reported
- Positive developer feedback on simplicity