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

    // Simple health check endpoint
    if (pathname === "/health") {
      return new Response(JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        message: "Sandbox SDK Tester is running"
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};