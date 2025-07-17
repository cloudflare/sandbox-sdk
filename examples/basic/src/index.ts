import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const hostname = url.hostname;

    // Check if this is a preview URL request
    // Pattern for production/custom domains: {port}-{sandbox-id}.{any-domain}
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
    const localPreviewMatch = pathname.match(/^\/preview\/(\d+)\/([^\/]+)(\/.*)?$/);
    if (localPreviewMatch) {
      const port = parseInt(localPreviewMatch[1]);
      const sandboxId = localPreviewMatch[2];
      const subPath = localPreviewMatch[3] || "/";
      
      // Get the sandbox instance using the sandbox ID from the URL
      // This could be either a friendly name or a Durable Object ID
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

    // Regular routes
    if (pathname.startsWith("/api")) {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      return sandbox.containerFetch(request);
    }

    if (pathname.startsWith("/test-file")) {
      // write a file to the sandbox
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      await sandbox.writeFile("/test-file.txt", "Hello, world!" + Date.now());
      const file = await sandbox.readFile("/test-file.txt");
      return new Response(file!.content, { status: 200 });
    }

    if (pathname.startsWith("/test-preview")) {
      // Example of using the preview URL feature
      // Use a consistent sandbox ID that we can reference in the preview URL
      const sandboxId = "test-preview-sandbox";
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      
      // Create a simple Bun HTTP server
      await sandbox.writeFile("/server.js", `
        Bun.serve({
          port: 8080,
          fetch(req) {
            const url = new URL(req.url);
            console.log(\`Server received request: \${req.method} \${url.pathname}\`);
            
            if (url.pathname === "/") {
              return new Response("Hello from Bun server! 🎉", {
                headers: { "Content-Type": "text/plain" }
              });
            }
            
            if (url.pathname === "/api/status") {
              return new Response(JSON.stringify({
                status: "running",
                timestamp: new Date().toISOString(),
                message: "Bun server is working!"
              }), {
                headers: { "Content-Type": "application/json" }
              });
            }
            
            return new Response("Not found", { status: 404 });
          },
        });
        
        console.log("Bun server running on port 8080");
      `);
      
      // Start the Bun server
      await sandbox.exec("bun", ["run", "/server.js"]);
      
      // Wait a moment for the server to start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Expose the port
      const preview = await sandbox.exposePort(8080, { name: "bun-server" });
      
      // For localhost, we need to override the URL to use our friendly sandbox ID
      // since the Durable Object ID will be a hash
      if (url.hostname.includes("localhost")) {
        preview.url = `http://localhost:8787/preview/8080/${sandboxId}`;
      }
      
      return new Response(JSON.stringify({
        message: "Bun server started and exposed",
        preview,
        sandboxId: sandboxId,
        note: "Use the sandboxId in the preview URL for localhost"
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname.startsWith("/test-check")) {
      // Debug endpoint to check if Bun server is running
      const sandboxId = "test-preview-sandbox";
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      
      // Check running processes
      const ps = await sandbox.exec("ps", ["aux"]);
      
      // Check exposed ports
      const exposedPorts = await sandbox.getExposedPorts();
      
      return new Response(JSON.stringify({
        processes: ps,
        exposedPorts: exposedPorts,
      }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
