import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
import { codeExamples } from "../shared/examples";
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
  listFiles,
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
import { createSession, executeCell, deleteSession } from "./endpoints/notebook";
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
function getUserSandbox(env: Env, request: Request) {
  // Get client-provided sandbox ID from header (persists across page reloads, unique per tab)
  const clientSandboxId = request.headers.get("X-Sandbox-Client-Id");

  // Use client ID if provided, otherwise generate one
  // In production, you would also use:
  // - Authentication headers
  // - URL parameters
  // - Session cookies
  const sandboxId = clientSandboxId || `sandbox-${Date.now()}-${generateSecureRandomString()}`;
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
      const sandbox = getUserSandbox(env, request) as unknown as Sandbox<unknown>;

      // Notebook API endpoints
      if (pathname === "/api/notebook/session" && request.method === "POST") {
        return await createSession(sandbox, request);
      }

      if (pathname === "/api/notebook/execute" && request.method === "POST") {
        return await executeCell(sandbox, request);
      }

      if (pathname === "/api/notebook/session" && request.method === "DELETE") {
        return await deleteSession(sandbox, request);
      }

      // Command Execution API
      if (pathname === "/api/execute" && request.method === "POST") {
        return await executeCommand(sandbox, request);
      }

      // Streaming Command Execution API
      if (pathname === "/api/execute/stream" && request.method === "POST") {
        return await executeCommandStream(sandbox, request);
      }

      // Process Management APIs
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
        return await streamProcessLogs(sandbox, pathname, request);
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

      if (pathname === "/api/list-files" && request.method === "POST") {
        return await listFiles(sandbox, request);
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

      // Helper function to run code examples
      async function runExample(exampleName: keyof typeof codeExamples) {
        try {
          const example = codeExamples[exampleName];
          const ctx = await sandbox.createCodeContext({ language: example.language });
          const execution = await sandbox.runCode(example.code, { context: ctx });
          
          const result: any = {
            stdout: execution.logs.stdout.join('\n'),
            stderr: execution.logs.stderr.join('\n'),
            error: execution.error || null
          };
          
          // Process rich outputs - collect ALL outputs, not just the first
          if (execution.results && execution.results.length > 0) {
            // For multiple outputs (e.g., multiple plots), collect them all
            const charts: string[] = [];
            const htmlOutputs: string[] = [];
            const latexOutputs: string[] = [];
            const markdownOutputs: string[] = [];
            
            for (const output of execution.results) {
              // Images (rename to user-friendly "chart")
              if (output.png && !result.chart) {
                result.chart = `data:image/png;base64,${output.png}`;
              } else if (output.png) {
                charts.push(`data:image/png;base64,${output.png}`);
              }
              
              // SVG images
              if (output.svg && !result.svg) {
                result.svg = output.svg;
              }
              
              // HTML content (tables, etc.)
              if (output.html && !result.html) {
                result.html = output.html;
              } else if (output.html) {
                htmlOutputs.push(output.html);
              }
              
              // JSON structured data
              if (output.json && !result.json) {
                result.json = output.json;
              }
              
              // LaTeX formulas - collect all of them
              if (output.latex) {
                latexOutputs.push(output.latex);
              }
              
              // Markdown formatted text - collect all of them  
              if (output.markdown) {
                markdownOutputs.push(output.markdown);
              }
              
              // Plain text - only include if we don't have other rich outputs
              if (output.text && !result.text && !result.json && !result.html) {
                result.text = output.text;
              }
            }
            
            // If we have multiple charts, include them
            if (charts.length > 0) {
              result.additionalCharts = charts;
            }
            
            // Combine all LaTeX outputs
            if (latexOutputs.length > 0) {
              result.latex = latexOutputs.join('\n\n');
            }
            
            // Combine all Markdown outputs
            if (markdownOutputs.length > 0) {
              result.markdown = markdownOutputs.join('\n\n');
            }
          }
          
          return jsonResponse(result);
        } catch (error: any) {
          return errorResponse(error.message || "Failed to run example", 500);
        }
      }

      // Code Interpreter Example APIs - Map endpoints to example names
      const exampleEndpoints: Record<string, keyof typeof codeExamples> = {
        "/api/examples/stdout-stderr": "stdout-stderr",
        "/api/examples/html-table": "html-table",
        "/api/examples/chart-png": "chart-png",
        "/api/examples/json-data": "json-data",
        "/api/examples/latex-math": "latex-math",
        "/api/examples/markdown-rich": "markdown-rich",
        "/api/examples/multiple-outputs": "multiple-outputs",
        "/api/examples/javascript-example": "javascript-example",
        "/api/examples/typescript-example": "typescript-example",
        "/api/examples/error-handling": "error-handling"
      };

      if (request.method === "GET" && exampleEndpoints[pathname]) {
        return runExample(exampleEndpoints[pathname]);
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
            "POST /api/list-files - List files in directory",
            "POST /api/delete - Delete file",
            "POST /api/rename - Rename file",
            "POST /api/move - Move file",
            "POST /api/mkdir - Create directory",
            "POST /api/git/checkout - Git checkout",
            "POST /api/templates/nextjs - Setup Next.js project",
            "POST /api/templates/react - Setup React project",
            "POST /api/templates/vue - Setup Vue project",
            "POST /api/templates/static - Setup static site",
            "POST /api/notebook/session - Create notebook session",
            "POST /api/notebook/execute - Execute notebook cell",
            "DELETE /api/notebook/session - Delete notebook session",
            "GET /api/examples/basic-python - Basic Python example",
            "GET /api/examples/chart - Chart generation example",
            "GET /api/examples/javascript - JavaScript execution example",
            "GET /api/examples/error - Error handling example",
          ]
        });
      }

      // Ping endpoint that actually initializes the container
      if (pathname === "/api/ping") {
        try {
          // Test the actual sandbox connection by calling a simple method
          // This will initialize the sandbox if it's not already running
          await sandbox.exec("echo 'Sandbox initialized'");
          return jsonResponse({
            message: "pong",
            timestamp: new Date().toISOString(),
            sandboxStatus: "ready"
          });
        } catch (error: any) {
          return jsonResponse({
            message: "pong",
            timestamp: new Date().toISOString(),
            sandboxStatus: "initializing",
            error: error.message
          }, 202); // 202 Accepted - processing in progress
        }
      }

      // Session Management APIs
      if (pathname === "/api/session/create" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { name, env, cwd, isolation = true } = body;

        const session = await sandbox.createSession({
          id: name || `session_${Date.now()}_${generateSecureRandomString()}`,
          env,
          cwd,
          isolation
        });

        return jsonResponse({ sessionId: session.id });
      }

      if (pathname.startsWith("/api/session/clear/") && request.method === "POST") {
        const sessionId = pathname.split("/").pop();

        // Note: The current SDK doesn't expose a direct session cleanup method
        // Sessions are automatically cleaned up by the container lifecycle
        return jsonResponse({ message: "Session cleanup initiated", sessionId });
      }

      // Fallback: serve static assets for all other requests
      return env.ASSETS.fetch(request);

    } catch (error: any) {
      console.error("API Error:", error);
      return errorResponse(`Internal server error: ${error.message}`, 500);
    }
  },
};