import { proxyToSandbox, getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route requests to exposed container ports via their preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    // Custom routes
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith("/api")) {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      return sandbox.containerFetch(request, 3000);
    }

    if (pathname.startsWith("/test-file")) {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      await sandbox.writeFile("test-file.txt", "Hello, world! " + Date.now());
      const file = await sandbox.readFile("test-file.txt");
      return new Response(file!.content, { status: 200 });
    }

    if (pathname.startsWith("/test-preview")) {
      const sandboxId = "test-preview-sandbox";
      const sandbox = getSandbox(env.Sandbox, sandboxId);

      // Create a simple Bun HTTP server
      await sandbox.writeFile("server.js", `
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

      // Start the Bun server in the background
      await sandbox.exec("bun", ["run", "server.js"], { background: true });

      // Wait a moment for the server to start
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Expose the port
      const preview = await sandbox.exposePort(8080, { name: "bun-server" });

      return new Response(JSON.stringify({
        message: "Bun server started and exposed",
        preview,
        sandboxId: sandboxId,
        note: "Access your server at the preview URL"
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname.startsWith("/test-check")) {
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

    if (pathname.startsWith("/test-multi-port")) {
      const sandboxId = "multi-port-sandbox";
      const sandbox = getSandbox(env.Sandbox, sandboxId);

      // Create an API server on port 3001 (avoiding 3000)
      await sandbox.writeFile("api-server.js", `
        Bun.serve({
          port: 3001,
          fetch(req) {
            const url = new URL(req.url);
            console.log(\`API server received: \${req.method} \${url.pathname}\`);

            if (url.pathname === "/api/data") {
              return new Response(JSON.stringify({
                data: "from API server",
                port: 3001,
                timestamp: new Date().toISOString()
              }), {
                headers: { "Content-Type": "application/json" }
              });
            }

            return new Response("API Not Found", { status: 404 });
          },
        });
        console.log("API server running on port 3001");
      `);

      // Create a web server on port 8080
      await sandbox.writeFile("web-server.js", `
        Bun.serve({
          port: 8080,
          fetch(req) {
            const url = new URL(req.url);
            console.log(\`Web server received: \${req.method} \${url.pathname}\`);

            const html = \`
              <!DOCTYPE html>
              <html>
              <head><title>Multi-Port Demo</title></head>
              <body>
                <h1>Web Server on Port 8080</h1>
                <p>This is the main web server.</p>
                <p>The API server is running on port 3001.</p>
                <p>Current time: \${new Date().toISOString()}</p>
              </body>
              </html>
            \`;

            return new Response(html, {
              headers: { "Content-Type": "text/html" }
            });
          },
        });
        console.log("Web server running on port 8080");
      `);

      // Start both servers
      await sandbox.exec("bun", ["run", "api-server.js"], { background: true });
      await sandbox.exec("bun", ["run", "web-server.js"], { background: true });

      // Expose both ports
      const apiPreview = await sandbox.exposePort(3001, { name: "api-server" });
      const webPreview = await sandbox.exposePort(8080, { name: "web-server" });

      return new Response(JSON.stringify({
        message: "Multiple servers started successfully",
        servers: {
          api: apiPreview,
          web: webPreview
        },
        sandboxId: sandboxId,
        note: "Each server is accessible at its own preview URL"
      }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};