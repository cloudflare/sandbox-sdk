/**
 * WebSocket Example Using SDK Helpers
 *
 * This demonstrates the simplified approach using the new WebSocket helpers
 * from @cloudflare/sandbox. Compare with index.ts to see the difference!
 */

import { createWebSocketHandler, Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      // Serve a simple HTML page for testing
      if (pathname === "/") {
        return new Response(getTestHTML(), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Route to different WebSocket handlers
    switch (pathname) {
      case "/ws/echo":
        return handleEchoWebSocket(request, env);
      case "/ws/code":
        return handleCodeExecutionWebSocket(request, env);
      case "/ws/process":
        return handleProcessStreamWebSocket(request, env);
      case "/ws/terminal":
        return handleTerminalWebSocket(request, env);
      default:
        return new Response("Unknown WebSocket endpoint", { status: 404 });
    }
  },
};

/**
 * Example 1: Echo Server (Simplified)
 */
async function handleEchoWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const { response, websocket } = await createWebSocketHandler(request, env.Sandbox, {
    onReady: (ws, sandboxId) => {
      ws.sendReady("Echo server connected", sandboxId);
    },
    onMessage: async (ws, message) => {
      switch (message.type) {
        case "echo":
          ws.send({
            type: "echo",
            data: message.data,
            timestamp: Date.now(),
          });
          break;

        case "execute":
          try {
            const result = await ws.raw.sandbox.exec(message.command);
            ws.sendResult({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            });
          } catch (error) {
            ws.sendError(error as Error);
          }
          break;
      }
    },
  });

  return response;
}

/**
 * Example 2: Code Execution (Simplified)
 */
async function handleCodeExecutionWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  let context: any = null;

  const { response, websocket, sandbox } = await createWebSocketHandler(
    request,
    env.Sandbox,
    {
      onReady: (ws) => {
        ws.sendReady("Code interpreter ready");
      },
      onMessage: async (ws, message) => {
        switch (message.type) {
          case "execute":
            try {
              // Create context if needed
              if (!context) {
                context = await sandbox.createCodeContext({
                  language: message.language || "python",
                });
              }

              // Use the helper method for streaming execution!
              await ws.runCodeWithStreaming(message.code, {
                language: message.language || "python",
                context,
              });
            } catch (error) {
              ws.sendError(error as Error);
            }
            break;

          case "reset":
            if (context) {
              await sandbox.deleteCodeContext(context.id);
              context = null;
            }
            ws.sendStatus("reset", "Context cleared");
            break;
        }
      },
    }
  );

  return response;
}

/**
 * Example 3: Process Streaming (Simplified)
 */
async function handleProcessStreamWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  const { response, websocket } = await createWebSocketHandler(request, env.Sandbox, {
    onReady: (ws) => {
      ws.sendReady("Process streaming ready");
    },
    onMessage: async (ws, message) => {
      switch (message.type) {
        case "start":
          try {
            // Use the helper method that auto-streams logs!
            await ws.startProcessWithStreaming(message.command);
          } catch (error) {
            ws.sendError(error as Error);
          }
          break;
      }
    },
  });

  return response;
}

/**
 * Example 4: Interactive Terminal (Simplified)
 */
async function handleTerminalWebSocket(
  request: Request,
  env: Env
): Promise<Response> {
  let shellProcess: any = null;

  const { response, websocket, sandbox } = await createWebSocketHandler(
    request,
    env.Sandbox,
    {
      onReady: async (ws) => {
        // Start shell process with streaming
        shellProcess = await ws.startProcessWithStreaming("/bin/bash");
        ws.sendReady("Terminal ready");
      },
      onMessage: async (ws, message) => {
        if (message.type === "input" && shellProcess) {
          try {
            // Write to stdin (this would need to be added to the SDK)
            await sandbox.exec(`echo "${message.data}" | /proc/${shellProcess.pid}/fd/0`);
          } catch (error) {
            ws.sendError(error as Error);
          }
        }
      },
      onClose: async (ws) => {
        // Cleanup
        if (shellProcess) {
          await sandbox.killProcess(shellProcess.id);
        }
      },
    }
  );

  return response;
}

// HTML test interface (same as before)
function getTestHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Sandbox WebSocket Examples (With Helpers)</title>
  <style>
    body {
      font-family: 'Courier New', monospace;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #1e1e1e;
      color: #d4d4d4;
    }
    h1 { color: #4ec9b0; }
    .note {
      background: #2d2d2d;
      border-left: 4px solid #0e639c;
      padding: 10px;
      margin: 20px 0;
    }
    .note strong {
      color: #4ec9b0;
    }
  </style>
</head>
<body>
  <h1>Sandbox WebSocket Examples</h1>
  <div class="note">
    <strong>Note:</strong> This version uses the new SDK WebSocket helpers!
    Check <code>index-with-helpers.ts</code> vs <code>index.ts</code> to see the difference.
  </div>
  <p>Open <code>index-with-helpers.ts</code> to see how much simpler the code is!</p>

  <h2>Key Improvements</h2>
  <ul>
    <li><strong>createWebSocketHandler()</strong> - Handles all boilerplate setup</li>
    <li><strong>ws.sendReady(), ws.sendError(), etc</strong> - Type-safe message sending</li>
    <li><strong>ws.runCodeWithStreaming()</strong> - Auto-streams code execution output</li>
    <li><strong>ws.startProcessWithStreaming()</strong> - Auto-streams process logs</li>
    <li><strong>Lifecycle callbacks</strong> - onReady, onMessage, onClose, onError</li>
  </ul>
</body>
</html>`;
}

export { Sandbox };
