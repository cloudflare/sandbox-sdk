# Preview URLs & Port Management

This feature allows you to expose ports from your sandbox containers and access them via public preview URLs.

## Overview

The Preview URLs feature enables you to:
- Explicitly expose container ports for external access
- Get public URLs to access services running in your sandbox
- Manage exposed ports (list, unexpose)
- Route preview requests through your Worker to the container

## API

### `sandbox.exposePort(port, options?)`

Exposes a port and returns a preview URL.

```typescript
const preview = await sandbox.exposePort(3000, { 
  name: "web-app"
});
console.log(preview.url); // https://3000-sandbox-abc123.workers.dev
```

**Parameters:**
- `port` (number): The port number to expose (1-65535)
- `options` (optional):
  - `name` (string): A friendly name for the exposed port

**Returns:**
```typescript
{
  url: string;    // The preview URL
  port: number;   // The exposed port
  name?: string;  // The friendly name (if provided)
}
```

**Note:** The hostname is automatically detected from the first request to the sandbox's Durable Object.

### `sandbox.unexposePort(port)`

Removes port exposure.

```typescript
await sandbox.unexposePort(3000);
```

**Parameters:**
- `port` (number): The port to unexpose

### `sandbox.getExposedPorts()`

Lists all currently exposed ports.

```typescript
const ports = await sandbox.getExposedPorts();
// Returns array of exposed ports with their preview URLs
```

**Returns:**
```typescript
Array<{
  url: string;
  port: number;
  name?: string;
  exposedAt: string;
}>
```

## Worker Setup

To handle preview URL requests, your Worker needs to route requests based on the URL pattern.

**Note for localhost development**: Since browsers don't support subdomains for localhost, preview URLs use a path-based pattern instead: `http://localhost:8787/preview/{port}/{sandbox-id}/*`

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const hostname = url.hostname;

    // Check if this is a preview URL request (production pattern)
    // Pattern: {port}-{sandbox-id}.{any-domain}
    const previewMatch = hostname.match(/^(\d+)-([a-zA-Z0-9-]+)\./);
    if (previewMatch) {
      const port = parseInt(previewMatch[1]);
      const sandboxId = previewMatch[2];
      
      // Get the sandbox instance
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      
      // Forward the request to the container's proxy endpoint
      const proxyUrl = `http://localhost:3000/proxy/${port}${pathname}${url.search}`;
      const proxyRequest = new Request(proxyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      
      return sandbox.containerFetch(proxyRequest);
    }

    // Check for localhost preview pattern: /preview/{port}/{sandbox-id}/*
    const localPreviewMatch = pathname.match(/^\/preview\/(\d+)\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (localPreviewMatch) {
      const port = parseInt(localPreviewMatch[1]);
      const sandboxId = localPreviewMatch[2];
      const subPath = localPreviewMatch[3] || "/";
      
      // Get the sandbox instance
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      
      // Forward the request to the container's proxy endpoint
      const proxyUrl = `http://localhost:3000/proxy/${port}${subPath}${url.search}`;
      const proxyRequest = new Request(proxyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      
      return sandbox.containerFetch(proxyRequest);
    }

    // Handle other routes...
  },
};
```

## Examples

### Example 1: Expose a Bun HTTP Server

```typescript
// Create a simple Bun server
await sandbox.writeFile("/server.js", `
  Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("Hello from Bun! 🎉");
    }
  });
`);

// Start the server
await sandbox.exec("bun", ["run", "/server.js"]);

// Expose the port
const preview = await sandbox.exposePort(8080, { 
  name: "bun-server"
});
console.log(`Server available at: ${preview.url}`);
```

### Example 2: Expose a Node.js Express App

```typescript
// Create a simple Express app
await sandbox.writeFile("/app.js", `
  const express = require('express');
  const app = express();
  
  app.get('/', (req, res) => {
    res.json({ message: 'Hello from sandbox!' });
  });
  
  app.listen(3000, () => {
    console.log('Server running on port 3000');
  });
`);

// Install dependencies and start
await sandbox.exec("npm", ["init", "-y"]);
await sandbox.exec("npm", ["install", "express"]);
await sandbox.exec("node", ["/app.js"]);

// Expose the app
const preview = await sandbox.exposePort(3000, { name: "api" });
console.log(`API endpoint: ${preview.url}`);
```

### Example 3: Manage Multiple Ports

```typescript
// Create and start multiple Bun services
await sandbox.writeFile("/main-server.js", `
  Bun.serve({
    port: 8080,
    fetch(req) {
      return new Response("Main server");
    }
  });
`);

await sandbox.writeFile("/api-server.js", `
  Bun.serve({
    port: 8081,
    fetch(req) {
      return Response.json({ api: "v1", status: "ok" });
    }
  });
`);

await sandbox.exec("bun", ["run", "/main-server.js"]);
await sandbox.exec("bun", ["run", "/api-server.js"]);

// Expose both
const mainServer = await sandbox.exposePort(8080, { name: "main" });
const apiServer = await sandbox.exposePort(8081, { name: "api" });

// List all exposed ports
const ports = await sandbox.getExposedPorts();
console.log(`Exposed ports: ${ports.length}`);

// Later, unexpose the API server
await sandbox.unexposePort(8081);
```

## How It Works

1. **Port Exposure**: When you call `exposePort()`, the container's command server registers the port as exposed
2. **Hostname Detection**: The SDK automatically captures the hostname from the first request to the Durable Object
3. **URL Generation**: The SDK generates a preview URL based on the environment:
   - **Production/Custom Domains**: `https://{port}-{sandbox-id}.{your-domain}` (subdomain-based)
   - **Localhost**: `http://localhost:8787/preview/{port}/{sandbox-id}/*` (path-based due to browser limitations)
4. **Request Routing**: When a request comes to a preview URL, your Worker:
   - For production: Parses the subdomain to extract port and sandbox ID
   - For localhost: Parses the path to extract port and sandbox ID
   - Gets the appropriate sandbox instance
   - Forwards the request to the container's proxy endpoint
5. **Proxying**: The container's command server proxies the request to `localhost:{port}`

## Limitations

- Only HTTP/HTTPS traffic is supported (no WebSocket support yet)
- Ports must be explicitly exposed - no automatic detection
- All exposed ports are publicly accessible (no authentication)
- The service must be running on the specified port before accessing the preview URL

## Security Considerations

- All preview URLs are public by default
- Ensure you don't expose sensitive services
- Consider implementing your own authentication layer if needed
- Unexpose ports when they're no longer needed

## Future Enhancements

Planned improvements include:
- WebSocket support
- HTTPS/TLS termination
- Authentication options
- Health checks
- Custom domains
- Port auto-detection