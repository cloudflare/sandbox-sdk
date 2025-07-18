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
    const pathname = url.pathname;

    if (pathname.startsWith("/api")) {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      return sandbox.containerFetch(request);
    }

    if (pathname.startsWith("/test-file")) {
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      await sandbox.writeFile("/test-file.txt", "Hello, world!" + Date.now());
      const file = await sandbox.readFile("/test-file.txt");
      return new Response(file!.content, { status: 200 });
    }

    if (pathname.startsWith("/test-preview")) {
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

      // Start the Bun server in the background
      await sandbox.exec("bun", ["run", "/server.js"], { background: true });

      // Expose the port
      const preview = await sandbox.exposePort(8080, { name: "bun-server" });

      return new Response(JSON.stringify({
        message: "Bun server started and exposed",
        preview,
        sandboxId: sandboxId,
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

    return new Response("Not found", { status: 404 });
  },
};