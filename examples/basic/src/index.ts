import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  executeCommand,
  executeCommandStream,
  exposePort,
  getProcess,
  getProcessLogs,
  killProcesses,
  listProcesses,
  startProcess,
  streamProcessLogs,
  unexposePort,
  readFile,
  deleteFile,
  renameFile,
  moveFile,
  createDirectory,
  gitCheckout,
  setupNextjs,
  setupReact,
  setupVue,
  setupStatic,
} from "./endpoints";
import { corsHeaders, errorResponse, jsonResponse, parseJsonBody } from "./http";

export { Sandbox } from "@cloudflare/sandbox";

// Helper function to generate cryptographically secure random strings
function generateSecureRandomString(length: number = 12): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
};

// Helper to get sandbox instance with user-specific ID
function getUserSandbox(env: Env) {
  // For demo purposes, use a fixed sandbox ID. In production, you might extract from:
  // - Authentication headers
  // - URL parameters
  // - Session cookies
  const sandboxId = "demo-user-sandbox";
  return getSandbox(env.Sandbox, sandboxId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    // PRIORITY: Route requests to exposed container ports via their preview URLs
    // This must happen BEFORE any other routing to bypass Wrangler's asset serving
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      const sandbox = getUserSandbox(env) as unknown as Sandbox<unknown>;

      // Command Execution API
      if (pathname === "/api/execute" && request.method === "POST") {
        return await executeCommand(sandbox, request);
      }

      // Streaming Command Execution API
      if (pathname === "/api/execute/stream" && request.method === "POST") {
        return await executeCommandStream(sandbox, request);
      }

      // Process Management APIs - Check if methods exist
      if (pathname === "/api/process/list" && request.method === "GET") {
        return await listProcesses(sandbox);
      }

      if (pathname === "/api/process/start" && request.method === "POST") {
        return await startProcess(sandbox, request);
      }

      if (pathname.startsWith("/api/process/") && request.method === "DELETE") {
        return await killProcesses(sandbox, pathname);
      }

      if (pathname.startsWith("/api/process/") && pathname.endsWith("/logs") && request.method === "GET") {
        return await getProcessLogs(sandbox, pathname);
      }

      if (pathname.startsWith("/api/process/") && pathname.endsWith("/stream") && request.method === "GET") {
        return await streamProcessLogs(sandbox, pathname);
      }

      if (pathname.startsWith("/api/process/") && request.method === "GET") {
        return await getProcess(sandbox, pathname);
      }

      // Port Management APIs
      if (pathname === "/api/expose-port" && request.method === "POST") {
        return await exposePort(sandbox, request);
      }

      if (pathname === "/api/unexpose-port" && request.method === "POST") {
        return await unexposePort(sandbox, request);
      }

      if (pathname === "/api/exposed-ports" && request.method === "GET") {
        // Automatically capture hostname from request
        const hostname = new URL(request.url).host;
        const ports = await sandbox.getExposedPorts(hostname);
        return jsonResponse({ ports });
      }

      // File Operations API
      if (pathname === "/api/write" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { path, content, encoding } = body;

        if (!path || content === undefined) {
          return errorResponse("Path and content are required");
        }

        await sandbox.writeFile(path, content, { encoding });
        return jsonResponse({ message: "File written", path });
      }

      if (pathname === "/api/read" && request.method === "POST") {
        return await readFile(sandbox, request);
      }

      if (pathname === "/api/delete" && request.method === "POST") {
        return await deleteFile(sandbox, request);
      }

      if (pathname === "/api/rename" && request.method === "POST") {
        return await renameFile(sandbox, request);
      }

      if (pathname === "/api/move" && request.method === "POST") {
        return await moveFile(sandbox, request);
      }

      if (pathname === "/api/mkdir" && request.method === "POST") {
        return await createDirectory(sandbox, request);
      }

      if (pathname === "/api/git/checkout" && request.method === "POST") {
        return await gitCheckout(sandbox, request);
      }

      // Template Setup APIs
      if (pathname === "/api/templates/nextjs" && request.method === "POST") {
        return await setupNextjs(sandbox, request);
      }

      if (pathname === "/api/templates/react" && request.method === "POST") {
        return await setupReact(sandbox, request);
      }

      if (pathname === "/api/templates/vue" && request.method === "POST") {
        return await setupVue(sandbox, request);
      }

      if (pathname === "/api/templates/static" && request.method === "POST") {
        return await setupStatic(sandbox, request);
      }

      // Session Management APIs
      if (pathname === "/api/session/create" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const sessionId = body.sessionId || `session_${Date.now()}_${generateSecureRandomString()}`;

        // Sessions are managed automatically by the SDK, just return the ID
        return jsonResponse(sessionId);
      }

      if (pathname.startsWith("/api/session/clear/") && request.method === "POST") {
        const sessionId = pathname.split("/").pop();

        // In a real implementation, you might want to clean up session state
        // For now, just return success
        return jsonResponse({ message: "Session cleared", sessionId });
      }

      // Health check endpoint
      if (pathname === "/health") {
        return jsonResponse({
          status: "healthy",
          timestamp: new Date().toISOString(),
          message: "Sandbox SDK Tester is running",
          apis: [
            "POST /api/execute - Execute commands",
            "POST /api/execute/stream - Execute with streaming",
            "GET /api/process/list - List processes",
            "POST /api/process/start - Start process",
            "DELETE /api/process/{id} - Kill process",
            "GET /api/process/{id}/logs - Get process logs",
            "GET /api/process/{id}/stream - Stream process logs",
            "POST /api/expose-port - Expose port",
            "GET /api/exposed-ports - List exposed ports",
            "POST /api/write - Write file",
            "POST /api/read - Read file",
            "POST /api/delete - Delete file",
            "POST /api/rename - Rename file",
            "POST /api/move - Move file",
            "POST /api/mkdir - Create directory",
            "POST /api/git/checkout - Git checkout",
            "POST /api/templates/nextjs - Setup Next.js project",
            "POST /api/templates/react - Setup React project",
            "POST /api/templates/vue - Setup Vue project",
            "POST /api/templates/static - Setup static site"
          ]
        });
      }

      // Ping endpoint that checks container state without triggering containerFetch
      if (pathname === "/api/ping") {
        try {
          // Use the new ping() method that doesn't trigger containerFetch
          const pingResult = await sandbox.ping();

          return jsonResponse({
            message: "pong",
            timestamp: new Date().toISOString(),
            sandboxStatus: pingResult.status,
            sandboxMessage: pingResult.message
          }, pingResult.status === 'ready' ? 200 : 202);
        } catch (error: any) {
          return jsonResponse({
            message: "pong",
            timestamp: new Date().toISOString(),
            sandboxStatus: "error",
            error: error.message
          }, 500);
        }
      }

      // Fallback: serve static assets for all other requests
      return env.ASSETS.fetch(request);

    } catch (error: any) {
      console.error("API Error:", error);
      return errorResponse(`Internal server error: ${error.message}`, 500);
    }
  },
};
