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
      const sandbox = getSandbox(env.Sandbox, "my-sandbox");
      
      // Start a simple Python HTTP server
      await sandbox.exec("python", ["-m", "http.server", "8080"]);
      
      // Expose the port
      const preview = await sandbox.exposePort(8080, { name: "python-server" });
      
      return new Response(JSON.stringify({
        message: "Python server started and exposed",
        preview,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
