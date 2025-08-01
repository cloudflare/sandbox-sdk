import { randomBytes } from "node:crypto";
import { serve } from "bun";
import { handleExecuteRequest, handleStreamingExecuteRequest } from "./handler/exec";
import {
  handleDeleteFileRequest,
  handleMkdirRequest,
  handleMoveFileRequest,
  handleReadFileRequest,
  handleRenameFileRequest,
  handleWriteFileRequest,
} from "./handler/file";
import { handleGitCheckoutRequest } from "./handler/git";
import {
  handleExposePortRequest,
  handleGetExposedPortsRequest,
  handleProxyRequest,
  handleUnexposePortRequest,
} from "./handler/ports";
import {
  handleGetProcessLogsRequest,
  handleGetProcessRequest,
  handleKillAllProcessesRequest,
  handleKillProcessRequest,
  handleListProcessesRequest,
  handleStartProcessRequest,
  handleStreamProcessLogsRequest,
} from "./handler/process";
import type { ProcessRecord, SessionData } from "./types";
import { JupyterServer, type CreateContextRequest } from "./jupyter-server";

// In-memory session storage (in production, you'd want to use a proper database)
const sessions = new Map<string, SessionData>();

// In-memory storage for exposed ports
const exposedPorts = new Map<number, { name?: string; exposedAt: Date }>();

// In-memory process storage - cleared on container restart
const processes = new Map<string, ProcessRecord>();

// Generate a unique session ID using cryptographically secure randomness
function generateSessionId(): string {
  return `session_${Date.now()}_${randomBytes(6).toString('hex')}`;
}

// Clean up old sessions (older than 1 hour)
function cleanupOldSessions() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [sessionId, session] of sessions.entries()) {
    if (session.createdAt < oneHourAgo && !session.activeProcess) {
      sessions.delete(sessionId);
      console.log(`[Server] Cleaned up old session: ${sessionId}`);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupOldSessions, 10 * 60 * 1000);

// Initialize Jupyter server
const jupyterServer = new JupyterServer();
let jupyterInitialized = false;

// Initialize Jupyter immediately since startup.sh ensures it's ready
(async () => {
  try {
    await jupyterServer.initialize();
    jupyterInitialized = true;
    console.log("[Container] Jupyter integration initialized successfully");
  } catch (error) {
    console.error("[Container] Failed to initialize Jupyter:", error);
    // Log more details to help debug
    if (error instanceof Error) {
      console.error("[Container] Error details:", error.message);
      console.error("[Container] Stack trace:", error.stack);
    }
  }
})();

const server = serve({
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    console.log(`[Container] Incoming ${req.method} request to ${pathname}`);

    // Handle CORS
    const corsHeaders = {
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    };

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      console.log(`[Container] Handling CORS preflight for ${pathname}`);
      return new Response(null, { headers: corsHeaders, status: 200 });
    }

    try {
      // Handle different routes
      console.log(`[Container] Processing ${req.method} ${pathname}`);
      switch (pathname) {
        case "/":
          return new Response("Hello from Bun server! 🚀", {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...corsHeaders,
            },
          });

        case "/api/session/create":
          if (req.method === "POST") {
            const sessionId = generateSessionId();
            const sessionData: SessionData = {
              activeProcess: null,
              createdAt: new Date(),
              sessionId,
            };
            sessions.set(sessionId, sessionData);

            console.log(`[Server] Created new session: ${sessionId}`);

            return new Response(
              JSON.stringify({
                message: "Session created successfully",
                sessionId,
                timestamp: new Date().toISOString(),
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/session/list":
          if (req.method === "GET") {
            const sessionList = Array.from(sessions.values()).map(
              (session) => ({
                createdAt: session.createdAt.toISOString(),
                hasActiveProcess: !!session.activeProcess,
                sessionId: session.sessionId,
              })
            );

            return new Response(
              JSON.stringify({
                count: sessionList.length,
                sessions: sessionList,
                timestamp: new Date().toISOString(),
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/execute":
          if (req.method === "POST") {
            return handleExecuteRequest(sessions, req, corsHeaders);
          }
          break;

        case "/api/execute/stream":
          if (req.method === "POST") {
            return handleStreamingExecuteRequest(sessions, req, corsHeaders);
          }
          break;

        case "/api/ping":
          if (req.method === "GET") {
            return new Response(
              JSON.stringify({
                message: "pong",
                timestamp: new Date().toISOString(),
                jupyter: jupyterInitialized ? "ready" : "not ready",
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/commands":
          if (req.method === "GET") {
            return new Response(
              JSON.stringify({
                availableCommands: [
                  "ls",
                  "pwd",
                  "echo",
                  "cat",
                  "grep",
                  "find",
                  "whoami",
                  "date",
                  "uptime",
                  "ps",
                  "top",
                  "df",
                  "du",
                  "free",
                ],
                timestamp: new Date().toISOString(),
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/git/checkout":
          if (req.method === "POST") {
            return handleGitCheckoutRequest(sessions, req, corsHeaders);
          }
          break;

        case "/api/mkdir":
          if (req.method === "POST") {
            return handleMkdirRequest(sessions, req, corsHeaders);
          }
          break;

        case "/api/write":
          if (req.method === "POST") {
            return handleWriteFileRequest(req, corsHeaders);
          }
          break;

        case "/api/read":
          if (req.method === "POST") {
            return handleReadFileRequest(req, corsHeaders);
          }
          break;

        case "/api/delete":
          if (req.method === "POST") {
            return handleDeleteFileRequest(req, corsHeaders);
          }
          break;

        case "/api/rename":
          if (req.method === "POST") {
            return handleRenameFileRequest(req, corsHeaders);
          }
          break;

        case "/api/move":
          if (req.method === "POST") {
            return handleMoveFileRequest(req, corsHeaders);
          }
          break;

        case "/api/expose-port":
          if (req.method === "POST") {
            return handleExposePortRequest(exposedPorts, req, corsHeaders);
          }
          break;

        case "/api/unexpose-port":
          if (req.method === "DELETE") {
            return handleUnexposePortRequest(exposedPorts, req, corsHeaders);
          }
          break;

        case "/api/exposed-ports":
          if (req.method === "GET") {
            return handleGetExposedPortsRequest(exposedPorts, req, corsHeaders);
          }
          break;

        case "/api/process/start":
          if (req.method === "POST") {
            return handleStartProcessRequest(processes, req, corsHeaders);
          }
          break;

        case "/api/process/list":
          if (req.method === "GET") {
            return handleListProcessesRequest(processes, req, corsHeaders);
          }
          break;

        case "/api/process/kill-all":
          if (req.method === "DELETE") {
            return handleKillAllProcessesRequest(processes, req, corsHeaders);
          }
          break;

        // Code interpreter endpoints
        case "/api/contexts":
          if (req.method === "POST") {
            if (!jupyterInitialized) {
              return new Response(
                JSON.stringify({
                  error: "Jupyter server is not ready. Please try again in a moment."
                }),
                {
                  status: 503,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
            try {
              const body = await req.json() as CreateContextRequest;
              const context = await jupyterServer.createContext(body);
              return new Response(
                JSON.stringify({
                  id: context.id,
                  language: context.language,
                  cwd: context.cwd,
                  createdAt: context.createdAt,
                  lastUsed: context.lastUsed
                }),
                {
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            } catch (error) {
              console.error("[Container] Error creating context:", error);
              return new Response(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "Failed to create context"
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          } else if (req.method === "GET") {
            if (!jupyterInitialized) {
              return new Response(
                JSON.stringify({ contexts: [] }),
                {
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
            const contexts = await jupyterServer.listContexts();
            return new Response(
              JSON.stringify({ contexts }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/execute/code":
          if (req.method === "POST") {
            if (!jupyterInitialized) {
              return new Response(
                JSON.stringify({
                  error: "Jupyter server is not ready. Please try again in a moment."
                }),
                {
                  status: 503,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
            try {
              const body = await req.json() as { context_id: string; code: string; language?: string };
              return await jupyterServer.executeCode(body.context_id, body.code, body.language);
            } catch (error) {
              console.error("[Container] Error executing code:", error);
              return new Response(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "Failed to execute code"
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          }
          break;

        default:
          // Handle dynamic routes for contexts
          if (pathname.startsWith("/api/contexts/") && pathname.split('/').length === 4) {
            const contextId = pathname.split('/')[3];
            if (req.method === "DELETE") {
              try {
                await jupyterServer.deleteContext(contextId);
                return new Response(
                  JSON.stringify({ success: true }),
                  {
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              } catch (error) {
                return new Response(
                  JSON.stringify({
                    error: error instanceof Error ? error.message : "Failed to delete context"
                  }),
                  {
                    status: error instanceof Error && error.message.includes("not found") ? 404 : 500,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }
            }
          }
          
          // Handle dynamic routes for individual processes
          if (pathname.startsWith("/api/process/")) {
            const segments = pathname.split('/');
            if (segments.length >= 4) {
              const processId = segments[3];
              const action = segments[4]; // Optional: logs, stream, etc.

              if (!action && req.method === "GET") {
                return handleGetProcessRequest(processes, req, corsHeaders, processId);
              } else if (!action && req.method === "DELETE") {
                return handleKillProcessRequest(processes, req, corsHeaders, processId);
              } else if (action === "logs" && req.method === "GET") {
                return handleGetProcessLogsRequest(processes, req, corsHeaders, processId);
              } else if (action === "stream" && req.method === "GET") {
                return handleStreamProcessLogsRequest(processes, req, corsHeaders, processId);
              }
            }
          }
          // Check if this is a proxy request for an exposed port
          if (pathname.startsWith("/proxy/")) {
            return handleProxyRequest(exposedPorts, req, corsHeaders);
          }

          console.log(`[Container] Route not found: ${pathname}`);
          return new Response("Not Found", {
            headers: corsHeaders,
            status: 404,
          });
      }
    } catch (error) {
      console.error(`[Container] Error handling ${req.method} ${pathname}:`, error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 500,
        }
      );
    }
  },
  hostname: "0.0.0.0",
  port: 3000,
  // We don't need this, but typescript complains
  websocket: { async message() { } },
});

console.log(`🚀 Bun server running on http://0.0.0.0:${server.port}`);
console.log(`📡 HTTP API endpoints available:`);
console.log(`   POST /api/session/create - Create a new session`);
console.log(`   GET  /api/session/list - List all sessions`);
console.log(`   POST /api/execute - Execute a command (non-streaming)`);
console.log(`   POST /api/execute/stream - Execute a command (streaming)`);
console.log(`   POST /api/git/checkout - Checkout a git repository`);
console.log(`   POST /api/mkdir - Create a directory`);
console.log(`   POST /api/write - Write a file`);
console.log(`   POST /api/read - Read a file`);
console.log(`   POST /api/delete - Delete a file`);
console.log(`   POST /api/rename - Rename a file`);
console.log(`   POST /api/move - Move a file`);
console.log(`   POST /api/expose-port - Expose a port for external access`);
console.log(`   DELETE /api/unexpose-port - Unexpose a port`);
console.log(`   GET  /api/exposed-ports - List exposed ports`);
console.log(`   POST /api/process/start - Start a background process`);
console.log(`   GET  /api/process/list - List all processes`);
console.log(`   GET  /api/process/{id} - Get process status`);
console.log(`   DELETE /api/process/{id} - Kill a process`);
console.log(`   GET  /api/process/{id}/logs - Get process logs`);
console.log(`   GET  /api/process/{id}/stream - Stream process logs (SSE)`);
console.log(`   DELETE /api/process/kill-all - Kill all processes`);
console.log(`   GET  /proxy/{port}/* - Proxy requests to exposed ports`);
console.log(`   POST /api/contexts - Create a code execution context`);
console.log(`   GET  /api/contexts - List all contexts`);
console.log(`   DELETE /api/contexts/{id} - Delete a context`);
console.log(`   POST /api/execute/code - Execute code in a context (streaming)`);
console.log(`   GET  /api/ping - Health check`);
console.log(`   GET  /api/commands - List available commands`);
