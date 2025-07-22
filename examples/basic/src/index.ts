import { proxyToSandbox, getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

// Helper to get sandbox instance with user-specific ID
function getUserSandbox(env: Env, request: Request) {
  // For demo purposes, use a fixed sandbox ID. In production, you might extract from:
  // - Authentication headers
  // - URL parameters
  // - Session cookies
  const sandboxId = "demo-user-sandbox";
  return getSandbox(env.Sandbox, sandboxId);
}

// Helper to parse JSON body safely
async function parseJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

// Helper for CORS headers
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Helper for error responses
function errorResponse(message: string, status: number = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Helper for success responses
function jsonResponse(data: any, status: number = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    // Route requests to exposed container ports via their preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      const sandbox = getUserSandbox(env, request);

      // Command Execution API
      if (pathname === "/api/execute" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { command, sessionId } = body;

        if (!command) {
          return errorResponse("Command is required");
        }

        // Use the current SDK API signature: exec(command, options)
        const result = await sandbox.exec(command, { sessionId });

        return jsonResponse({
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          command: result.command,
          duration: result.duration
        });
      }

      // Streaming Command Execution API
      if (pathname === "/api/execute/stream" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { command, sessionId } = body;

        if (!command) {
          return errorResponse("Command is required");
        }

        // Create readable stream for SSE
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        // Start streaming in the background
        (async () => {
          try {
            const encoder = new TextEncoder();
            
            // Send start event
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: 'start',
              timestamp: new Date().toISOString(),
              command: command
            })}\n\n`));

            // Check if execStream method exists, otherwise fallback to regular exec
            if (typeof sandbox.execStream === 'function') {
              for await (const event of sandbox.execStream(command, { sessionId })) {
                await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                
                if (event.type === 'complete' || event.type === 'error') {
                  break;
                }
              }
            } else {
              // Fallback to regular execution if streaming not available
              try {
                const result = await sandbox.exec(command, { sessionId });
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'complete',
                  timestamp: new Date().toISOString(),
                  exitCode: result.exitCode,
                  result
                })}\n\n`));
              } catch (error: any) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'error',
                  timestamp: new Date().toISOString(),
                  error: error.message
                })}\n\n`));
              }
            }
          } catch (error: any) {
            const errorEvent = {
              type: 'error',
              timestamp: new Date().toISOString(),
              error: error.message
            };
            await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...corsHeaders(),
          },
        });
      }

      // Process Management APIs - Check if methods exist
      if (pathname === "/api/process/list" && request.method === "GET") {
        if (typeof sandbox.listProcesses === 'function') {
          const processes = await sandbox.listProcesses();
          return jsonResponse({ processes });
        } else {
          return errorResponse("Process management not implemented in current SDK version", 501);
        }
      }

      if (pathname === "/api/process/start" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { command, processId, sessionId, timeout, env: envVars, cwd } = body;

        if (!command) {
          return errorResponse("Command is required");
        }

        if (typeof sandbox.startProcess === 'function') {
          const process = await sandbox.startProcess(command, {
            processId,
            sessionId,
            timeout,
            env: envVars,
            cwd
          });
          return jsonResponse(process);
        } else {
          return errorResponse("Process management not implemented in current SDK version", 501);
        }
      }

      if (pathname.startsWith("/api/process/") && request.method === "DELETE") {
        const processId = pathname.split("/").pop();
        if (processId === "kill-all") {
          if (typeof sandbox.killAllProcesses === 'function') {
            const result = await sandbox.killAllProcesses();
            return jsonResponse({ message: "All processes killed", killedCount: result });
          } else {
            return errorResponse("Process management not implemented in current SDK version", 501);
          }
        } else if (processId) {
          if (typeof sandbox.killProcess === 'function') {
            await sandbox.killProcess(processId);
            return jsonResponse({ message: "Process killed", processId });
          } else {
            return errorResponse("Process management not implemented in current SDK version", 501);
          }
        } else {
          return errorResponse("Process ID is required");
        }
      }

      if (pathname.startsWith("/api/process/") && pathname.endsWith("/logs") && request.method === "GET") {
        const pathParts = pathname.split("/");
        const processId = pathParts[pathParts.length - 2];
        
        if (!processId) {
          return errorResponse("Process ID is required");
        }

        if (typeof sandbox.getProcessLogs === 'function') {
          const logs = await sandbox.getProcessLogs(processId);
          return jsonResponse(logs);
        } else {
          return errorResponse("Process management not implemented in current SDK version", 501);
        }
      }

      if (pathname.startsWith("/api/process/") && pathname.endsWith("/stream") && request.method === "GET") {
        const pathParts = pathname.split("/");
        const processId = pathParts[pathParts.length - 2];
        
        if (!processId) {
          return errorResponse("Process ID is required");
        }

        // Check if process exists first
        if (typeof sandbox.getProcess === 'function') {
          try {
            const process = await sandbox.getProcess(processId);
            if (!process) {
              return errorResponse("Process not found", 404);
            }
          } catch (error: any) {
            return errorResponse(`Failed to check process: ${error.message}`, 500);
          }
        }

        // Use proper AsyncIterable streaming from SDK
        if (typeof sandbox.streamProcessLogs === 'function') {
          const stream = new ReadableStream({
            async start(controller) {
              try {
                const encoder = new TextEncoder();
                
                // Send initial connection event
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: 'connected',
                  timestamp: new Date().toISOString(),
                  processId
                })}\n\n`));
                
                // Use the SDK's AsyncIterable streaming
                for await (const logEvent of sandbox.streamProcessLogs(processId)) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(logEvent)}\n\n`));
                }
                
                // Send completion event
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: 'stream_complete',
                  timestamp: new Date().toISOString(),
                  processId
                })}\n\n`));
                
              } catch (error: any) {
                console.error('Process log streaming error:', error);
                const errorEvent = {
                  type: 'error',
                  timestamp: new Date().toISOString(),
                  processId,
                  data: error.message
                };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
              } finally {
                controller.close();
              }
            }
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...corsHeaders(),
            },
          });
        } else {
          return errorResponse("Process streaming not implemented in current SDK version", 501);
        }
      }

      if (pathname.startsWith("/api/process/") && request.method === "GET") {
        const processId = pathname.split("/").pop();
        if (!processId) {
          return errorResponse("Process ID is required");
        }

        if (typeof sandbox.getProcess === 'function') {
          const process = await sandbox.getProcess(processId);
          if (!process) {
            return errorResponse("Process not found", 404);
          }
          return jsonResponse(process);
        } else {
          return errorResponse("Process management not implemented in current SDK version", 501);
        }
      }

      // Port Management APIs
      if (pathname === "/api/expose-port" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { port, name } = body;

        if (!port) {
          return errorResponse("Port number is required");
        }

        const preview = await sandbox.exposePort(port, name ? { name } : undefined);
        return jsonResponse(preview);
      }

      if (pathname === "/api/unexpose-port" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const { port } = body;

        if (!port) {
          return errorResponse("Port number is required");
        }

        await sandbox.unexposePort(port);
        return jsonResponse({ message: "Port unexposed", port });
      }

      if (pathname === "/api/exposed-ports" && request.method === "GET") {
        const ports = await sandbox.getExposedPorts();
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

      // Session Management APIs
      if (pathname === "/api/session/create" && request.method === "POST") {
        const body = await parseJsonBody(request);
        const sessionId = body.sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        
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
            "POST /api/write - Write file"
          ]
        });
      }

      // Simple ping endpoint (no method call needed)
      if (pathname === "/api/ping") {
        return jsonResponse({ message: "pong", timestamp: new Date().toISOString() });
      }

      return errorResponse("Endpoint not found", 404);

    } catch (error: any) {
      console.error("API Error:", error);
      return errorResponse(`Internal server error: ${error.message}`, 500);
    }
  },
};